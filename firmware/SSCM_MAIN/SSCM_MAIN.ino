#define FIRMWARE_VERSION "1.0.3"
#define BOARD_NAME "SSCM-MAIN"

// Set to 0 to disable Serial logging in production builds
#define SSCM_DEBUG 1
#if SSCM_DEBUG
  #define LOG(msg) Serial.println(msg)
#else
  #define LOG(msg)
#endif

/**
 * =============================================================================
 * Smart Shoe Care Machine — Main Controller Firmware (ESP32-S3)
 * =============================================================================
 *
 * Architecture:
 *   This is a multi-file Arduino sketch. The main .ino file contains global
 *   state, constants, setup(), and loop(). Peripheral logic is split into
 *   companion .ino files (motors, sensors, relays, etc.) which share this
 *   file's global scope via the Arduino build system.
 *
 * Communication:
 *   - WiFi + WebSocket → Backend server (pairing, commands, telemetry)
 *   - ESP-NOW → SSCM-CAM board (classification, heartbeat, LED control)
 *   - Serial → Debug console & manual commands
 *
 * Services:
 *   The machine offers three shoe care services:
 *     1. Cleaning — Motorized brush + foam dispenser + linear slide
 *     2. Drying   — PTC heater + blower with closed-loop temp control
 *     3. Sterilizing — UV-C light + ultrasonic atomizer mist
 *
 * Required Libraries:
 *   - WiFi, HTTPClient, Preferences (built-in ESP32)
 *   - WebSocketsClient (Markus Sattler)  — Install via Library Manager
 *   - DHT sensor library (Adafruit)      — Install via Library Manager
 *   - Adafruit Unified Sensor            — Install via Library Manager
 *   - ESP32Servo (Kevin Harrington)      — Install via Library Manager
 *   - Adafruit NeoPixel (Adafruit)       — Install via Library Manager
 *
 * Build Notes:
 *   - Board: ESP32S3 Dev Module (or LOLIN S3 Pro)
 *   - Partition: Default 4MB or larger
 *   - Set SSCM_DEBUG to 0 for production (strips all Serial output)
 *   - Set USE_LOCAL_BACKEND to 1 for local dev server
 *   - Lint warnings "Unable to handle compilation" are expected —
 *     the Arduino IDE compiles all .ino files as one translation unit.
 */

#include "html_pages.h"
#include <Adafruit_NeoPixel.h>
#include <ArduinoOTA.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_now.h>
#include <esp_wifi.h>

/* ===================== WIFI STATE ===================== */
// NVS (Non-Volatile Storage) for persisting WiFi creds, pairing, and totals
Preferences prefs;

// Captive portal HTTP server for initial WiFi setup (SoftAP mode)
WiFiServer wifiServer(80);
bool wifiConnected = false;
unsigned long wifiRetryDelay = 5000;     // Exponential backoff delay (doubles up to 30s)
unsigned long wifiRetryStart = 0;
bool softAPStarted = false;
unsigned long wifiStartTime = 0;         // Timestamp of last WiFi.begin() call
unsigned long lastWiFiRetry = 0;

#define WIFI_TIMEOUT 60000               // Max time before falling back to SoftAP
#define WIFI_RETRY_INTERVAL 5000         // Interval between WiFi status checks

/* ===================== WEBSOCKET ===================== */
WebSocketsClient webSocket;
bool wsConnected = false;
bool wsInitialized = false;
const unsigned long WS_RECONNECT_INTERVAL = 5000;

/* ===================== STATUS UPDATE ===================== */
unsigned long lastStatusUpdate = 0;
const unsigned long STATUS_UPDATE_INTERVAL = 5000;

/* ===================== ESP-NOW — ESP32-CAM COMMUNICATION ===================== */
// Hybrid architecture:
//   ESP-NOW (250-byte packets, <1ms latency) for classification + heartbeat.
//   WiFi on CAM is optional — used only for HTTP MJPEG streaming.
//   All struct layouts MUST match SSCM_CAM.ino exactly (byte-level ABI).

// ---- Shared structs — must match SSCM_CAM.ino exactly ----

typedef struct {
  uint8_t type;
  char groupToken[10];
  char deviceId[24];
  char ssid[32];
  char password[64];
  char wsHost[64];
  uint16_t wsPort;
} PairingBroadcast;

typedef struct {
  uint8_t type;
  char camOwnDeviceId[24];
  char camIp[20];
} PairingAck;

typedef struct {
  uint8_t type;
  uint8_t status;
  char shoeType[32];
  float confidence;
} CamMessage;

// Message type constants
#define CAM_MSG_PAIR_REQUEST  1
#define CAM_MSG_PAIR_ACK      2
#define CAM_MSG_CLASSIFY_REQUEST 3
#define CAM_MSG_CLASSIFY_RESULT  4
#define CAM_MSG_STATUS_PING   5
#define CAM_MSG_STATUS_PONG   6
#define CAM_MSG_LED_ENABLE    7
#define CAM_MSG_LED_DISABLE   8
#define CAM_MSG_FACTORY_RESET 9

// Status codes in CamMessage.status
#define CAM_STATUS_OK            0
#define CAM_STATUS_ERROR         1
#define CAM_STATUS_TIMEOUT       2
#define CAM_STATUS_BUSY          3
#define CAM_STATUS_NOT_READY     4
#define CAM_STATUS_LOW_CONFIDENCE 5
#define CAM_STATUS_API_HANDLED   6

// ---- ESP-NOW state ----
bool espNowInitialized = false;
bool camIsReady = false;
unsigned long lastCamHeartbeat = 0;
#define CAM_HEARTBEAT_TIMEOUT 60000
unsigned long lastCamPing = 0;
#define CAM_PING_INTERVAL 30000

// ---- Deferred ESP-NOW dispatch (cross-core producer–consumer queue) ----
// Problem: ESP-NOW recv runs on WiFi task (core 0). Calling webSocket.sendTXT()
//   from core 0 deadlocks because the WS library holds a mutex owned by core 1.
// Solution: onDataRecv() enqueues actions here; loop() on core 1 dequeues and
//   dispatches them safely.
enum EspNowPending : uint8_t {
  ESPNOW_NONE = 0,
  ESPNOW_CLASSIFY_OK = 1,     // CAM returned a valid shoe type
  ESPNOW_CLASSIFY_ERROR = 2,  // CAM returned an error status
  ESPNOW_CAM_PAIRED = 3,      // CAM accepted our pairing broadcast
  ESPNOW_API_HANDLED = 4      // CAM POSTed to Gemini; backend broadcasts result
};
#define ESPNOW_QUEUE_SIZE 4
struct EspNowEntry {
  EspNowPending action;
  char shoeType[32];
  float confidence;
  char errorCode[32];
};
static EspNowEntry espNowQueue[ESPNOW_QUEUE_SIZE];  // Lock-free ring buffer
static uint8_t espNowQueueHead = 0;                 // Consumer index (loop)
static uint8_t espNowQueueTail = 0;                 // Producer index (onDataRecv)
static portMUX_TYPE espNowMux = portMUX_INITIALIZER_UNLOCKED;

// Pairing broadcast retry
unsigned long lastPairingBroadcastTime = 0;
const unsigned long PAIRING_BROADCAST_INTERVAL = 5000;
bool pairingBroadcastStarted = false;

// CAM MAC address (locked after first PairingAck)
uint8_t camMacAddress[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
bool camMacPaired = false;
String pairedCamDeviceId = "";
String pairedCamIp = "";

uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---- Classification via ESP-NOW ----
bool classificationPending = false;
unsigned long classificationRequestTime = 0;
const unsigned long CAM_CLASSIFY_TIMEOUT_MS = 20000;

/* ===================== CLASSIFICATION STATE ===================== */
String lastClassificationResult = "";
float lastClassificationConfidence = 0.0;
bool classificationLedOn = false;

/* ===================== COIN SLOT (pulse-counting) ===================== */
// Coin acceptor outputs N falling-edge pulses per coin (1 pulse = PHP 1).
// ISR counts pulses; loop() processes them after COIN_COMPLETE_TIMEOUT.
#define COIN_SLOT_PIN 5
volatile unsigned long lastCoinPulseTime = 0;
volatile unsigned int currentCoinPulses = 0;
unsigned int totalCoinPesos = 0;
const unsigned long COIN_PULSE_DEBOUNCE_TIME = 100;  // Reject bounces <100ms
const unsigned long COIN_COMPLETE_TIMEOUT = 500;     // No more pulses → coin done

/* ===================== BILL ACCEPTOR (pulse-counting) ===================== */
// Bill acceptor: 1 pulse = PHP 10. Same ISR pattern as coin slot.
#define BILL_PULSE_PIN 4
volatile unsigned long lastBillPulseTime = 0;
volatile unsigned int currentBillPulses = 0;
unsigned int totalBillPesos = 0;
unsigned int totalPesos = 0;
const unsigned long BILL_PULSE_DEBOUNCE_TIME = 100;
const unsigned long BILL_COMPLETE_TIMEOUT = 500;

/* ===================== PAYMENT CONTROL ===================== */
// Payment hardware is gated: acceptors only count when paymentEnabled == true.
// After enabling, a 3s stabilization delay prevents EMI-induced phantom pulses.
volatile bool paymentEnabled = false;
bool totalsDirty = false;          // True when RAM totals diverge from NVS
unsigned long lastTotalsSave = 0;
#define TOTALS_SAVE_INTERVAL 30000 // Batch NVS writes to avoid flash wear
volatile unsigned long paymentEnableTime = 0;
const unsigned long PAYMENT_STABILIZATION_DELAY = 3000;
static portMUX_TYPE paymentMux = portMUX_INITIALIZER_UNLOCKED;

/* ===================== 8-CHANNEL RELAY MODULE ===================== */
// Active-HIGH relay board. Each channel powers a specific load:
#define RELAY_1_PIN  3  // CH1: Bill + Coin acceptor power
#define RELAY_2_PIN  8  // CH2: Bottom exhaust fan (purge / over-temp cooling)
#define RELAY_3_PIN  18 // CH3: Centrifugal blower fan (drying airflow)
#define RELAY_4_PIN  17 // CH4: Left PTC ceramic heater
#define RELAY_5_PIN  16 // CH5: Diaphragm foam pump (cleaning)
#define RELAY_6_PIN  15 // CH6: Right PTC ceramic heater
#define RELAY_7_PIN  7  // CH7: Ultrasonic mist maker + mist fan (sterilizing)
#define RELAY_8_PIN  6  // CH8: UV-C germicidal light (sterilizing)

#define RELAY_ON  HIGH
#define RELAY_OFF LOW

bool relay1State = false;
bool relay2State = false;
bool relay3State = false;
bool relay4State = false;
bool relay5State = false;
bool relay6State = false;
bool relay7State = false;
bool relay8State = false;

/* ===================== SERVICE CONTROL ===================== */
bool serviceActive = false;
unsigned long serviceStartTime = 0;
unsigned long serviceDuration = 0;
String currentCareType = "";
String currentShoeType = "";
String currentServiceType = "";
const unsigned long SERVICE_STATUS_UPDATE_INTERVAL = 1000;
unsigned long lastServiceStatusUpdate = 0;

/* ===================== PURGE STATE ===================== */
bool purgeActive = false;
unsigned long purgeStartTime = 0;
String purgeServiceType = "";
String purgeShoeType = "";
String purgeCareType = "";
const unsigned long PURGE_DURATION_MS = 15000;

/* ===================== DRYING TEMPERATURE CONTROL ===================== */
// Closed-loop hysteresis: heater ON below 35°C, OFF above 40°C.
// Prevents relay chatter that would occur with a single threshold.
const float DRYING_TEMP_LOW  = 35.0;  // Heater turns ON below this
const float DRYING_TEMP_HIGH = 40.0;  // Heater turns OFF above this
bool dryingHeaterOn = false;
bool dryingExhaustOn = false;          // Exhaust fan activates when heater OFF

/* ===================== CLEANING SERVICE STATE MACHINE ===================== */
// The cleaning service runs a multi-phase sequence:
//   Phase 0: Idle
//   Phase 1: Top linear slide extends to max (foam dispensing position)
//   Phase 2: Top linear slide retracts to 0 (spreading foam)
//   Phase 3: Top linear slide extends back to max (positioning for brush)
//   Phase 4: Brush motors CW (forward scrub)
//   Phase 5: Brush motors CCW (reverse scrub)
//   Phase 6: Coast transition (motors off briefly between CW↔CCW)
// Brush cycles repeat BRUSH_TOTAL_CYCLES times, then service completes.
const long CLEANING_MAX_POSITION = 4800; // 480mm × 10 steps/mm
int cleaningPhase = 0;

const unsigned long BRUSH_DURATION_MS  = 30000;  // Duration of each CW or CCW phase
const unsigned long BRUSH_COAST_MS     = 500;    // Pause between direction changes
const int BRUSH_TOTAL_CYCLES           = 10;     // Number of full CW+CCW cycles
const int BRUSH_MOTOR_SPEED            = 255;    // Full speed (8-bit PWM)
int brushCurrentCycle = 0;
unsigned long brushPhaseStartTime = 0;
int brushNextPhase = 0;                          // Which phase to enter after coast

/* ===================== DHT22 TEMPERATURE & HUMIDITY SENSOR ===================== */
#define DHT_PIN  9
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

float currentTemperature = 0.0;
float currentHumidity = 0.0;
unsigned long lastDHTRead = 0;
const unsigned long DHT_READ_INTERVAL = 5000;

/* ===================== JSN-SR20-Y1 ULTRASONIC DISTANCE SENSORS ===================== */
#define ATOMIZER_TRIG_PIN 10
#define ATOMIZER_ECHO_PIN 11
#define FOAM_TRIG_PIN     12
#define FOAM_ECHO_PIN     13

int currentAtomizerDistance = 0;
int currentFoamDistance = 0;
unsigned long lastUltrasonicRead = 0;
const unsigned long ULTRASONIC_READ_INTERVAL = 5000;

/* ===================== SERVO MOTORS (MG995) ===================== */
#define SERVO_LEFT_PIN  19
#define SERVO_RIGHT_PIN 14

Servo servoLeft;
Servo servoRight;

int currentLeftPosition = 0;
int currentRightPosition = 180;
int targetLeftPosition = 0;
int targetRightPosition = 180;
bool servosMoving = false;
unsigned long lastServoUpdate = 0;
const unsigned long SERVO_UPDATE_INTERVAL = 15;

const int SERVO_SLOW_STEP_INTERVAL = 105;
const int SERVO_FAST_STEP_INTERVAL = 1;
int servoStepInterval = SERVO_SLOW_STEP_INTERVAL;
int servoStepCounter = 0;

// Forward declarations (needed for default parameter values)
void setServoPositions(int leftPos, bool fastMode = false);
void startService(String shoeType, String serviceType, String careType,
                  unsigned long customDurationSeconds = 0,
                  long customCleaningDistanceMm = -1);
void stopService();

// IRAM_ATTR functions — Arduino cannot auto-generate prototypes for these
void IRAM_ATTR handleCoinPulse();
void IRAM_ATTR handleBillPulse();

/* ===================== DRV8871 DC MOTOR DRIVERS ===================== */
#define MOTOR_LEFT_IN1_PIN  21
#define MOTOR_LEFT_IN2_PIN  47
#define MOTOR_RIGHT_IN1_PIN 48
#define MOTOR_RIGHT_IN2_PIN 45

const int MOTOR_PWM_FREQ       = 1000;
const int MOTOR_PWM_RESOLUTION = 8;
// LEDC channels for DC motors (2.0.x uses channel-based API; 0-3 reserved for servos)
#define MOTOR_LEFT_IN1_CH  4
#define MOTOR_LEFT_IN2_CH  5
#define MOTOR_RIGHT_IN1_CH 6
#define MOTOR_RIGHT_IN2_CH 7

int currentLeftMotorSpeed  = 0;
int currentRightMotorSpeed = 0;

/* ===================== TB6600 STEPPER 1 — TOP LINEAR SLIDE ===================== */
// Drives the top linear rail (foam dispenser carriage). NEMA11 + TB6600 driver.
// Position is persisted in NVS to survive power cycles.
#define STEPPER1_STEP_PIN 36
#define STEPPER1_DIR_PIN  35

const int STEPPER1_STEPS_PER_REV  = 200;   // 1.8° per step (full-step mode)
const int STEPPER1_MICROSTEPS     = 1;
const int STEPPER1_STEPS_PER_MM   = 10;    // Lead screw pitch = 0.1mm/step
const int STEPPER1_MAX_SPEED      = 800;   // steps/sec max
const unsigned long STEPPER1_MIN_PULSE_WIDTH = 2; // µs

long currentStepper1Position = 0;          // Loaded from NVS at boot
long targetStepper1Position  = 0;
int  stepper1Speed = 800;
bool stepper1Moving = false;
unsigned long lastStepper1Update = 0;
unsigned long stepper1StepInterval = 1250; // µs between steps (= 1e6 / speed)

/* ===================== TB6600 STEPPER 2 — SIDE LINEAR SLIDE ===================== */
// Drives the side linear rail (shoe holder / conveyor). Mini rail + TB6600.
#define STEPPER2_STEP_PIN 37
#define STEPPER2_DIR_PIN  38

const int STEPPER2_STEPS_PER_REV  = 200;
const int STEPPER2_MICROSTEPS     = 1;
const int STEPPER2_STEPS_PER_MM   = 200;   // Higher resolution lead screw
const int STEPPER2_MAX_SPEED      = 24000; // Faster rail, finer pitch
const long STEPPER2_MAX_POSITION  = 20000; // Software endstop (100mm)
const unsigned long STEPPER2_MIN_PULSE_WIDTH = 2;

long currentStepper2Position = 0;          // Loaded from NVS at boot
long targetStepper2Position  = 0;
int  stepper2Speed = 1500;
bool stepper2Moving = false;
unsigned long lastStepper2Update = 0;
unsigned long stepper2StepInterval = 667;

/* ===================== WS2812B RGB LED STRIP ===================== */
#define RGB_DATA_PIN  2   // ← change to match your rewired pin (was 39 = USB D−, do not use)
#define RGB_NUM_LEDS  58

Adafruit_NeoPixel strip(RGB_NUM_LEDS, RGB_DATA_PIN, NEO_GRB + NEO_KHZ800);

int currentRed   = 0;
int currentGreen = 0;
int currentBlue  = 0;

/* ===================== PAIRING ===================== */
String pairingCode = "";
String deviceId    = "";
String groupToken  = "";
bool isPaired  = false;
bool camSynced = false;
String camDeviceId = "";

/* ===================== BACKEND URL ===================== */
// ============================================================
// ⚠ CHANGE BEFORE FLASHING — Set to 1 for local, 0 for production
#define USE_LOCAL_BACKEND 0
// ============================================================

#if USE_LOCAL_BACKEND
#define BACKEND_HOST_STR "192.168.43.147"
#define BACKEND_PORT_NUM 3000
#define BACKEND_URL_STR  "http://192.168.43.147:3000"
#else
#define BACKEND_HOST_STR "smart-shoe-care-machine.onrender.com"
#define BACKEND_PORT_NUM 443
#define BACKEND_URL_STR  "https://smart-shoe-care-machine.onrender.com"
#endif

const char *BACKEND_HOST = BACKEND_HOST_STR;
const int   BACKEND_PORT = BACKEND_PORT_NUM;
const char *BACKEND_URL  = BACKEND_URL_STR;

/* ===================== OTA ===================== */
bool otaInitialized = false;

/* ===================== SETUP ===================== */
void setup() {
  Serial.begin(115200);
  delay(1000);
  LOG("[Setup] Booting Firmware Version: " FIRMWARE_VERSION);

  prefs.begin("sscm", false);

  currentStepper1Position = prefs.getLong("s1pos", 0);
  currentStepper2Position = prefs.getLong("s2pos", 0);

  // Factory reset via BOOT button (GPIO0) held at power-on for 3s
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
    LOG("[Setup] Hold detected — factory reset in 3s...");
    delay(3000);
    if (digitalRead(0) == LOW) {
      factoryReset();
    }
  }

  // DHT sensor
  dht.begin();
  LOG("[Setup] DHT Temperature Sensor OK");

  // Ultrasonic sensors
  pinMode(ATOMIZER_TRIG_PIN, OUTPUT);
  pinMode(ATOMIZER_ECHO_PIN, INPUT);
  digitalWrite(ATOMIZER_TRIG_PIN, LOW);
  pinMode(FOAM_TRIG_PIN, OUTPUT);
  pinMode(FOAM_ECHO_PIN, INPUT);
  digitalWrite(FOAM_TRIG_PIN, LOW);
  LOG("[Setup] Ultrasonic Sensor OK");

  // Servo motors
  servoLeft.attach(SERVO_LEFT_PIN);
  servoRight.attach(SERVO_RIGHT_PIN);
  servoLeft.write(0);
  servoRight.write(180);
  currentLeftPosition  = 0;
  currentRightPosition = 180;
  targetLeftPosition   = 0;
  targetRightPosition  = 180;
  LOG("[Setup] Servos OK");

  // DC motor drivers — set LOW before PWM attach to prevent spin at boot
  pinMode(MOTOR_LEFT_IN1_PIN,  OUTPUT);
  pinMode(MOTOR_LEFT_IN2_PIN,  OUTPUT);
  pinMode(MOTOR_RIGHT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2_PIN, OUTPUT);
  digitalWrite(MOTOR_LEFT_IN1_PIN,  LOW);
  digitalWrite(MOTOR_LEFT_IN2_PIN,  LOW);
  digitalWrite(MOTOR_RIGHT_IN1_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN2_PIN, LOW);
  ledcSetup(MOTOR_LEFT_IN1_CH,  MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcAttachPin(MOTOR_LEFT_IN1_PIN,  MOTOR_LEFT_IN1_CH);
  ledcWrite(MOTOR_LEFT_IN1_CH,  0);
  ledcSetup(MOTOR_LEFT_IN2_CH,  MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcAttachPin(MOTOR_LEFT_IN2_PIN,  MOTOR_LEFT_IN2_CH);
  ledcWrite(MOTOR_LEFT_IN2_CH,  0);
  ledcSetup(MOTOR_RIGHT_IN1_CH, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcAttachPin(MOTOR_RIGHT_IN1_PIN, MOTOR_RIGHT_IN1_CH);
  ledcWrite(MOTOR_RIGHT_IN1_CH, 0);
  ledcSetup(MOTOR_RIGHT_IN2_CH, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcAttachPin(MOTOR_RIGHT_IN2_PIN, MOTOR_RIGHT_IN2_CH);
  ledcWrite(MOTOR_RIGHT_IN2_CH, 0);
  motorsCoast();
  LOG("[Setup] Motors OK");

  // Stepper 1 — top linear
  pinMode(STEPPER1_STEP_PIN, OUTPUT);
  pinMode(STEPPER1_DIR_PIN,  OUTPUT);
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  digitalWrite(STEPPER1_DIR_PIN,  LOW);
  setStepper1Speed(800);

  // Stepper 2 — side linear
  pinMode(STEPPER2_STEP_PIN, OUTPUT);
  pinMode(STEPPER2_DIR_PIN,  OUTPUT);
  digitalWrite(STEPPER2_STEP_PIN, LOW);
  digitalWrite(STEPPER2_DIR_PIN,  LOW);
  setStepper2Speed(1500);

  // Move to boot positions if needed
  if (currentStepper1Position != CLEANING_MAX_POSITION) {
    LOG("[Setup] Top linear stepper not at home (" + String(currentStepper1Position) + ") — moving");
    stepper1MoveTo(CLEANING_MAX_POSITION);
  }
  if (currentStepper2Position != 0) {
    LOG("[Setup] side linear steppers not at home (" + String(currentStepper2Position) + ") — moving");
    stepper2MoveTo(0);
  }
  LOG("[SSCM] Top and Side Linear Steppers OK");

  // NeoPixel LED strip
  strip.begin();
  strip.setBrightness(100);
  strip.show();
  LOG("[SSCM] RGB LED Strip OK");

  // 8-channel relay
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  pinMode(RELAY_3_PIN, OUTPUT);
  pinMode(RELAY_4_PIN, OUTPUT);
  pinMode(RELAY_5_PIN, OUTPUT);
  pinMode(RELAY_6_PIN, OUTPUT);
  pinMode(RELAY_7_PIN, OUTPUT);
  pinMode(RELAY_8_PIN, OUTPUT);
  allRelaysOff();
  LOG("[SSCM] Relays 1-8 OK");

  // Brief stabilization delay — prevents brownout from combined inrush current
  delay(200);

  // Payment hardware interrupts
  pinMode(COIN_SLOT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_SLOT_PIN), handleCoinPulse, FALLING);
  pinMode(BILL_PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BILL_PULSE_PIN), handleBillPulse, FALLING);
  LOG("[SSCM] Coin and Bill interrupts OK");

  // Load totals from NVS
  totalCoinPesos = prefs.getUInt("totalCoinPesos", 0);
  totalBillPesos = prefs.getUInt("totalBillPesos", 0);
  totalPesos     = totalCoinPesos + totalBillPesos;

  // Device ID (persistent, derived from chip MAC)
  deviceId = prefs.getString("deviceId", "");
  if (deviceId.length() == 0) {
    deviceId = generateDeviceId();
    prefs.putString("deviceId", deviceId);
  }

  // Group token (persistent, generated once on first boot)
  groupToken = prefs.getString("groupToken", "");
  if (groupToken.length() == 0) {
    groupToken = generateGroupToken();
    prefs.putString("groupToken", groupToken);
  }

  // Pairing state
  isPaired = prefs.getBool("paired", false);
  if (!isPaired) {
    pairingCode = generatePairingCode();
  }

  LOG("[SSCM] Device: " + deviceId);
  LOG("[SSCM] Paired: " + String(isPaired ? "yes" : "no, code=" + pairingCode));

  // WiFi
  String storedSSID = prefs.getString("ssid", "");
  if (storedSSID.length() == 0) {
    LOG("[SSCM] No WiFi creds — SoftAP starting");
    startSoftAP();
    LOG("[SSCM] SoftAP ready — connect to 'Smart Shoe Care Machine Setup'");
  } else {
    LOG("[SSCM] WiFi creds found — connecting to: " + storedSSID);
    WiFi.mode(WIFI_STA);
    delay(100);
    initESPNow();
    LOG("[SSCM] ESP-NOW ready");
    delay(100);
    connectWiFi();
  }

  LOG("[SSCM] Setup complete. Free heap: " + String(ESP.getFreeHeap() / 1024) + " KB");
}

/* ===================== MAIN LOOP ===================== */
// Execution order matters:
//   1. OTA + WebSocket housekeeping
//   2. ESP-NOW deferred dispatch (cross-core safe)
//   3. Stepper/servo position updates (time-critical, µs-level)
//   4. Payment pulse processing (after ISR debounce timeout)
//   5. CAM heartbeat monitoring
//   6. Serial command processing
//   7. WiFi state machine (connect → retry → SoftAP fallback)
//   8. Periodic sensor readings + service state machine
void loop() {
  if (otaInitialized) ArduinoOTA.handle();

  webSocket.loop();

  // Dispatch deferred ESP-NOW results (enqueued from onDataRecv on core 0,
  // dispatched here on core 1 to avoid deadlocking webSocket.sendTXT())
  {
    portENTER_CRITICAL(&espNowMux);
    bool hasEntry = (espNowQueueHead != espNowQueueTail);
    EspNowEntry entry;
    if (hasEntry) {
      entry = espNowQueue[espNowQueueHead];
      espNowQueueHead = (espNowQueueHead + 1) % ESPNOW_QUEUE_SIZE;
    }
    portEXIT_CRITICAL(&espNowMux);

    if (hasEntry) {
      switch (entry.action) {
        case ESPNOW_CLASSIFY_OK:
          handleClassificationResultFromCAM(String(entry.shoeType), entry.confidence);
          break;
        case ESPNOW_CLASSIFY_ERROR:
          relayClassificationErrorToBackend(String(entry.errorCode));
          break;
        case ESPNOW_CAM_PAIRED:
          sendCamPairedToBackend();
          break;
        case ESPNOW_API_HANDLED:
          wsLog("info", "CAM: Gemini API handled classification result");
          break;
        default:
          break;
      }
    }
  }

  updateServoPositions();
  updateStepper1Position();
  updateStepper2Position();

  // ---- Payment pulse processing ----
  // ISR increments currentCoinPulses/currentBillPulses on each falling edge.
  // After COIN_COMPLETE_TIMEOUT with no new pulses, we treat the count as final.
  if (paymentEnabled && currentCoinPulses > 0) {
    if (millis() - lastCoinPulseTime >= COIN_COMPLETE_TIMEOUT) {
      portENTER_CRITICAL(&paymentMux);
      unsigned int coinValue = currentCoinPulses;
      currentCoinPulses = 0;
      portEXIT_CRITICAL(&paymentMux);

      totalCoinPesos += coinValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty = true;

      LOG("[COIN] PHP" + String(coinValue) + " | Total: PHP" + String(totalPesos));

      if (isPaired && wsConnected) {
        String msg = "{\"type\":\"coin-inserted\",\"deviceId\":\"" + deviceId +
                     "\",\"coinValue\":" + String(coinValue) +
                     ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(msg);
        wsLog("info", "Coin inserted: ₱" + String(coinValue) + " | Total: ₱" + String(totalPesos));
      }
    }
  }

  // Bill insertion processing
  if (paymentEnabled && currentBillPulses > 0) {
    if (millis() - lastBillPulseTime >= BILL_COMPLETE_TIMEOUT) {
      portENTER_CRITICAL(&paymentMux);
      unsigned int billPulses = currentBillPulses;
      currentBillPulses = 0;
      portEXIT_CRITICAL(&paymentMux);

      unsigned int billValue = billPulses * 10; // 1 pulse = 10 pesos
      totalBillPesos += billValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty = true;

      LOG("[BILL] PHP" + String(billValue) + " | Total: PHP" + String(totalPesos));

      if (isPaired && wsConnected) {
        String msg = "{\"type\":\"bill-inserted\",\"deviceId\":\"" + deviceId +
                     "\",\"billValue\":" + String(billValue) +
                     ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(msg);
        wsLog("info", "Bill inserted: ₱" + String(billValue) + " | Total: ₱" + String(totalPesos));
      }
    }
  }

  // Periodic NVS flush for coin/bill totals
  if (totalsDirty && (millis() - lastTotalsSave >= TOTALS_SAVE_INTERVAL)) {
    prefs.putUInt("totalCoinPesos", totalCoinPesos);
    prefs.putUInt("totalBillPesos", totalBillPesos);
    lastTotalsSave = millis();
    totalsDirty = false;

  }

  // CAM keep-alive ping
  if (camIsReady && camMacPaired && (millis() - lastCamPing >= CAM_PING_INTERVAL)) {
    lastCamPing = millis();
    CamMessage ping;
    memset(&ping, 0, sizeof(ping));
    ping.type = CAM_MSG_STATUS_PING;
    esp_now_send(camMacAddress, (uint8_t *)&ping, sizeof(ping));
  }

  // CAM heartbeat timeout
  if (camIsReady && (millis() - lastCamHeartbeat > CAM_HEARTBEAT_TIMEOUT)) {
    camIsReady = false;
    lastCamHeartbeat = millis();
    LOG("[CAM] Heartbeat timeout");
  }

  // Pairing broadcast retry until CAM sends PairingAck
  if (!camIsReady && pairingBroadcastStarted) {
    if (millis() - lastPairingBroadcastTime >= PAIRING_BROADCAST_INTERVAL) {
      sendPairingBroadcast();
    }
  }

  // Classification timeout
  if (classificationPending &&
      (millis() - classificationRequestTime >= CAM_CLASSIFY_TIMEOUT_MS)) {
    classificationPending = false;
    LOG("[CAM] Classification timeout");
    wsLog("warn", "Classification timeout — CAM did not respond");
    relayClassificationErrorToBackend("CAM_RESPONSE_TIMEOUT");
  }

  // Serial commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    handleSerialCommand(cmd);
  }

  // WiFi portal
  if (softAPStarted) {
    handleWiFiPortal();
  }

  /* ================= WIFI STATE MACHINE =================
   * States: Disconnected → Connecting → Connected → (if lost) → Retry with backoff → SoftAP fallback
   * SoftAP runs a captive portal for WiFi credential entry.
   */

  if (wifiConnected && WiFi.status() != WL_CONNECTED) {
    LOG("[WiFi] Disconnected");
    wifiConnected = false;
    wsConnected = false;
    wifiStartTime = millis();
    lastWiFiRetry = millis();
    connectWiFi();
    return;
  }

  if (wifiConnected && !otaInitialized) {
    setupOTA();
    otaInitialized = true;
  }

  if (!wifiConnected && WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    softAPStarted = false;
    wifiRetryDelay = 5000;
    wifiRetryStart = 0;

    LOG("[WiFi] Connected: " + WiFi.localIP().toString());

    wifiServer.stop();
    WiFi.softAPdisconnect(true);

    if (!isPaired) {
      sendDeviceRegistration();
    }

    if (!wsConnected) {
      webSocket.disconnect();
      wsInitialized = false;
    }

    connectWebSocket();

    delay(100);
    sendPairingBroadcast();
  }

  // WiFi retry with exponential backoff
  if (!wifiConnected && !softAPStarted) {
    if (millis() - lastWiFiRetry >= WIFI_RETRY_INTERVAL) {
      lastWiFiRetry = millis();
      wl_status_t status = WiFi.status();

      if (status == WL_CONNECTED) return;

      if (status == WL_IDLE_STATUS || status == WL_DISCONNECTED) {

        WiFi.begin(prefs.getString("ssid", "").c_str(),
                   prefs.getString("pass", "").c_str());
      }

      if (millis() - wifiStartTime > WIFI_TIMEOUT) {
        if (wifiRetryStart == 0) {
          startSoftAP();
          wifiRetryStart = millis();
        } else if (millis() - wifiRetryStart >= wifiRetryDelay) {
          wifiRetryDelay = min(wifiRetryDelay * 2, 30000UL);
          wifiRetryStart = 0;
          wifiStartTime = millis();
          String ssid = prefs.getString("ssid", "");
          String pass = prefs.getString("pass", "");
          if (ssid.length() > 0) {
            WiFi.begin(ssid.c_str(), pass.c_str());
          }
        }
      }
    }
  }

  if (!wifiConnected) return;

  /* ================= STATUS UPDATE (HEARTBEAT + KEEP-ALIVE) ================= */
  // Sends status every 5s to keep WS alive. Every 30s, re-subscribes and
  // syncs CAM state to heal server restarts or late-joining dashboards.
  if (wsConnected && millis() - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
    lastStatusUpdate = millis();

    String statusMsg = "{\"type\":\"status-update\",\"deviceId\":\"" + deviceId +
                       "\",\"camSynced\":" + (camSynced ? "true" : "false") +
                       ",\"camDeviceId\":\"" + camDeviceId +
                       "\",\"isPaired\":" + (isPaired ? "true" : "false") + "}";
    webSocket.sendTXT(statusMsg);

    // Periodic re-subscribe and sync every 30s to heal server restarts / late joins
    static unsigned long lastForceSync = 0;
    if (millis() - lastForceSync >= 30000) {
      lastForceSync = millis();
      webSocket.sendTXT("{\"type\":\"subscribe\",\"deviceId\":\"" + deviceId + "\"}");
      webSocket.sendTXT("{\"type\":\"cam-sync-status\",\"deviceId\":\"" + deviceId +
                        "\",\"camSynced\":" + (camSynced ? "true" : "false") +
                        ",\"camDeviceId\":\"" + camDeviceId + "\"}");
    }
  }

  /* ================= SENSOR READINGS ================= */
  // Ultrasonic sensors use pulseIn() which blocks ~30ms per reading.
  // Skip when steppers are moving to avoid missing step pulses.
  if (wsConnected && !stepper1Moving && !stepper2Moving) {

    if (isPaired && millis() - lastDHTRead >= DHT_READ_INTERVAL) {
      lastDHTRead = millis();
      if (readDHT11()) {
        sendDHTDataViaWebSocket();
      }
    }

    if (isPaired && millis() - lastUltrasonicRead >= ULTRASONIC_READ_INTERVAL) {
      lastUltrasonicRead = millis();
      bool atomizerOk = readAtomizerLevel();
      bool foamOk     = readFoamLevel();
      if (atomizerOk || foamOk) {
        sendUltrasonicDataViaWebSocket();
      }
    }
  }

  /* ================= SERVICE HANDLING ================= */
  handleService();
  handleDryingTemperature();
  handlePurge();

  yield();
}
