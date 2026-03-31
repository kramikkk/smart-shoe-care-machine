// Set to 0 to disable Serial logging in production builds
#define SSCM_DEBUG 1

#define FIRMWARE_VERSION "1.0.1"
#define BOARD_NAME "SSCM-MAIN"

/*
 * Smart Shoe Care Machine - WiFi & Pairing with WebSocket
 * Firmware with WiFi configuration and real-time device pairing via WebSocket
 *
 * Required Libraries:
 * - WiFi (built-in with ESP32)
 * - HTTPClient (built-in with ESP32)
 * - Preferences (built-in with ESP32)
 * - WebSocketsClient (by Markus Sattler) - Install via Library Manager
 * - DHT sensor library (by Adafruit) - Install via Library Manager
 * - Adafruit Unified Sensor - Install via Library Manager
 * - ESP32Servo (by Kevin Harrington) - Install via Library Manager
 * - Adafruit NeoPixel (by Adafruit) - Install via Library Manager
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

/* ===================== WIFI ===================== */
Preferences prefs;

WiFiServer wifiServer(80);
bool wifiConnected = false;
unsigned long wifiRetryDelay =
    5000; // Backoff delay for WiFi timeout retry (grows up to 30s)
unsigned long wifiRetryStart =
    0; // Timestamp when retry wait began (0 = not waiting)
bool softAPStarted = false;
unsigned long wifiStartTime = 0;
unsigned long lastWiFiRetry = 0;

#define WIFI_TIMEOUT 60000       // 1 minute
#define WIFI_RETRY_INTERVAL 5000 // Retry every 5 seconds

/* ===================== WEBSOCKET ===================== */
WebSocketsClient webSocket;
bool wsConnected = false;
bool wsInitialized = false; // begin() must be called exactly once
const unsigned long WS_RECONNECT_INTERVAL =
    5000; // Library setReconnectInterval value

/* ===================== STATUS UPDATE ===================== */
unsigned long lastStatusUpdate = 0;
const unsigned long STATUS_UPDATE_INTERVAL =
    5000; // Update status every 5 seconds

/* ===================== ESP-NOW - ESP32-CAM COMMUNICATION =====================
 */
// Hybrid communication: ESP-NOW for classification (fast, offline-capable),
// WiFi/WebSocket optional on CAM for HTTP streaming only.

// ---- Shared structs — must match EI_SHOE_CLASSIFICATION.ino exactly ----

// Pairing broadcast from main board → CAM
typedef struct {
  uint8_t type;        // CAM_MSG_PAIR_REQUEST = 1
  char groupToken[10]; // 8 hex chars + null
  char deviceId[24];   // Main board device ID
  char ssid[32];       // WiFi SSID for CAM streaming
  char password[64];   // WiFi password
  char wsHost[64];     // Backend host (informational for CAM)
  uint16_t wsPort;     // Backend port
} PairingBroadcast;

// Pairing acknowledgment from CAM → main board
typedef struct {
  uint8_t type;            // CAM_MSG_PAIR_ACK = 2
  char camOwnDeviceId[24]; // e.g., SSCM-CAM-D4DB1C
  char camIp[20];          // CAM's WiFi IP (empty if not connected yet)
} PairingAck;

// Runtime classification/control message (bidirectional)
typedef struct {
  uint8_t type;      // Message type constant
  uint8_t status;    // Status code constant
  char shoeType[32]; // "sneaker", "leather", etc.
  float confidence;  // 0.0 - 1.0
} CamMessage;

// Message type constants
#define CAM_MSG_PAIR_REQUEST 1
#define CAM_MSG_PAIR_ACK 2
#define CAM_MSG_CLASSIFY_REQUEST 3
#define CAM_MSG_CLASSIFY_RESULT 4
#define CAM_MSG_STATUS_PING 5
#define CAM_MSG_STATUS_PONG 6
#define CAM_MSG_LED_ENABLE 7
#define CAM_MSG_LED_DISABLE 8
#define CAM_MSG_FACTORY_RESET 9

// Status codes in CamMessage.status
#define CAM_STATUS_OK 0
#define CAM_STATUS_ERROR 1
#define CAM_STATUS_TIMEOUT 2
#define CAM_STATUS_BUSY 3
#define CAM_STATUS_NOT_READY 4
#define CAM_STATUS_LOW_CONFIDENCE 5
#define CAM_STATUS_API_HANDLED 6 // CAM ACK: Gemini API handled the result

// ---- ESP-NOW state ----
bool espNowInitialized = false;
bool camIsReady = false; // True after PairingAck received from CAM
unsigned long lastCamHeartbeat = 0;
#define CAM_HEARTBEAT_TIMEOUT 60000
unsigned long lastCamPing = 0;
#define CAM_PING_INTERVAL                                                      \
  30000 // Ping CAM every 30s (half the heartbeat timeout)

// ---- Deferred ESP-NOW dispatch ----
// ESP-NOW recv callback runs in the WiFi task (core 0) — calling
// webSocket.sendTXT() from it can deadlock. We enqueue here and dispatch in
// loop() (core 1). Uses a 4-entry circular queue + portMUX to handle
// back-to-back messages safely.
enum EspNowPending : uint8_t {
  ESPNOW_NONE = 0,
  ESPNOW_CLASSIFY_OK = 1,
  ESPNOW_CLASSIFY_ERROR = 2,
  ESPNOW_CAM_PAIRED = 3,
  ESPNOW_API_HANDLED = 4
};
#define ESPNOW_QUEUE_SIZE 4
struct EspNowEntry {
  EspNowPending action;
  char shoeType[32];
  float confidence;
  char errorCode[32];
};
static EspNowEntry espNowQueue[ESPNOW_QUEUE_SIZE];
static uint8_t espNowQueueHead = 0; // next entry to read
static uint8_t espNowQueueTail = 0; // next slot to write
static portMUX_TYPE espNowMux = portMUX_INITIALIZER_UNLOCKED;

// Enqueue a deferred ESP-NOW action (call from onDataRecv only)
static void espNowEnqueue(EspNowPending action, const char *shoeType = "",
                          float confidence = 0.0f, const char *errorCode = "") {
  portENTER_CRITICAL(&espNowMux);
  uint8_t next = (espNowQueueTail + 1) % ESPNOW_QUEUE_SIZE;
  if (next != espNowQueueHead) {
    espNowQueue[espNowQueueTail].action = action;
    strncpy(espNowQueue[espNowQueueTail].shoeType, shoeType, 31);
    espNowQueue[espNowQueueTail].shoeType[31] = '\0';
    espNowQueue[espNowQueueTail].confidence = confidence;
    strncpy(espNowQueue[espNowQueueTail].errorCode, errorCode, 31);
    espNowQueue[espNowQueueTail].errorCode[31] = '\0';
    espNowQueueTail = next;
  } else {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Dispatch queue full — message dropped");
#endif
  }
  portEXIT_CRITICAL(&espNowMux);
}

// Pairing broadcast retry (retries until CAM sends PairingAck)
unsigned long lastPairingBroadcastTime = 0;
const unsigned long PAIRING_BROADCAST_INTERVAL = 5000;
bool pairingBroadcastStarted = false;

// CAM MAC address (locked after first PairingAck)
uint8_t camMacAddress[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
bool camMacPaired = false;
String pairedCamDeviceId = ""; // e.g., SSCM-CAM-D4DB1C
String pairedCamIp = "";       // CAM's WiFi IP for streaming

// Broadcast address used during initial pairing
uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---- Classification via ESP-NOW ----
bool classificationPending = false;
unsigned long classificationRequestTime = 0;
const unsigned long CAM_CLASSIFY_TIMEOUT_MS = 20000; // 20s fallback timeout

/* ===================== CLASSIFICATION STATE ===================== */
// Classification via ESP-NOW direct path (not routed through backend)
String lastClassificationResult = "";
float lastClassificationConfidence = 0.0;
bool classificationLedOn = false;

/* ===================== COIN SLOT ===================== */
#define COIN_SLOT_PIN 5
volatile unsigned long lastCoinPulseTime = 0;
volatile unsigned int currentCoinPulses = 0;
unsigned int totalCoinPesos = 0;
const unsigned long COIN_PULSE_DEBOUNCE_TIME =
    100; // 10ms debounce — filters contact bounce (~1-5ms) without dropping
         // valid pulses (coin acceptors send pulses every ~30-60ms)
const unsigned long COIN_COMPLETE_TIMEOUT =
    500; // 300ms to confirm coin insertion complete

/* ===================== BILL ACCEPTOR ===================== */
#define BILL_PULSE_PIN 4
volatile unsigned long lastBillPulseTime = 0;
volatile unsigned int currentBillPulses = 0;
unsigned int totalBillPesos = 0;
unsigned int totalPesos = 0; // Combined total (coins + bills)
const unsigned long BILL_PULSE_DEBOUNCE_TIME =
    100; // 10ms debounce — same reasoning as COIN_PULSE_DEBOUNCE_TIME
const unsigned long BILL_COMPLETE_TIMEOUT =
    500; // 300ms to confirm bill insertion complete

/* ===================== PAYMENT CONTROL ===================== */
volatile bool paymentEnabled =
    false; // Only accept payments when explicitly enabled from frontend
bool totalsDirty =
    false; // Set when coin/bill totals change; flushed to NVS periodically
unsigned long lastTotalsSave = 0;
#define TOTALS_SAVE_INTERVAL                                                   \
  30000 // ms — flush dirty totals to NVS at most once per 30s
volatile unsigned long paymentEnableTime =
    0; // Timestamp when payment relay was turned on
const unsigned long PAYMENT_STABILIZATION_DELAY =
    3000; // 3 second delay after relay turns on
static portMUX_TYPE paymentMux =
    portMUX_INITIALIZER_UNLOCKED; // For atomic pulse read+clear

/* ===================== 8-CHANNEL RELAY ===================== */
#define RELAY_1_PIN                                                            \
  3 // Channel 1: Bill + Coin (combined power for both acceptors)
#define RELAY_2_PIN 8  // Channel 2: Bottom Exhaust
#define RELAY_3_PIN 18 // Channel 3: Centrifugal Blower Fan
#define RELAY_4_PIN 17 // Channel 4: Left PTC Ceramic Heater
#define RELAY_5_PIN 16 // Channel 5: Diaphragm Pump
#define RELAY_6_PIN 15 // Channel 6: Right PTC Ceramic Heater
#define RELAY_7_PIN 7  // Channel 7: Ultrasonic Mist Maker + Mist Fan (combined)
#define RELAY_8_PIN 6  // Channel 8: UVC Light

// This relay module is active HIGH (HIGH = ON, LOW = OFF)
#define RELAY_ON HIGH
#define RELAY_OFF LOW

bool relay1State = false; // Bill + Coin (combined power for both acceptors)
bool relay2State = false; // Bottom Exhaust
bool relay3State = false; // Centrifugal Blower Fan
bool relay4State = false; // Left PTC Ceramic Heater
bool relay5State = false; // Diaphragm Pump
bool relay6State = false; // Right PTC Ceramic Heater
bool relay7State = false; // Ultrasonic Mist Maker + Mist Fan (combined)
bool relay8State = false; // UVC Light

/* ===================== SERVICE CONTROL ===================== */
bool serviceActive = false;
unsigned long serviceStartTime = 0;
unsigned long serviceDuration = 0; // Duration in milliseconds
String currentCareType = "";
String currentShoeType = "";
String currentServiceType = "";
const unsigned long SERVICE_STATUS_UPDATE_INTERVAL =
    1000; // Send updates every second
unsigned long lastServiceStatusUpdate = 0;

/* ===================== PURGE STATE ===================== */
bool purgeActive = false;
unsigned long purgeStartTime = 0;
String purgeServiceType = "";
String purgeShoeType = "";
String purgeCareType = "";
const unsigned long PURGE_DURATION_MS = 15000; // 15 seconds

/* ===================== DRYING TEMPERATURE CONTROL ===================== */
// Target range: 35–40°C for quick drying without damaging shoe materials
// Below 35°C: heater ON, exhaust OFF  → heat up
// Above 40°C: heater OFF, exhaust ON  → cool down / release hot air
// 35–40°C:    maintain current state  (hysteresis band)
const float DRYING_TEMP_LOW = 35.0; // °C — heater turns ON below this
const float DRYING_TEMP_HIGH =
    40.0; // °C — heater turns OFF, exhaust ON above this
bool dryingHeaterOn = false;
bool dryingExhaustOn = false;

/* ===================== STERILIZING STATE ===================== */
// UVC + Atomizer/Fan run simultaneously for the full service duration

/* ===================== CLEANING SERVICE STATE ===================== */
// Cleaning mode phases:
// Phase 0: Not cleaning
// Phase 1: RGB ON, Pump ON, Side linear moving — wait 3s for liquid to travel
// Phase 2: Top linear moving forward to max position (pump ON)
// Phase 3: Top linear returning to home (pump ON)
// Phase 4: Brushing clockwise — pump OFF at start of this phase
// Phase 5: Brushing counter-clockwise
// After 3 complete brush cycles, cleaning ends

const long CLEANING_MAX_POSITION = 4800; // 480mm * 10 steps/mm = 4800 steps
int cleaningPhase = 0;
const unsigned long CLEANING_PUMP_DELAY_MS =
    3000; // 3s delay before top linear starts

// Brushing cycle state
const unsigned long BRUSH_DURATION_MS =
    30000; // 30 seconds per direction (60s full CW+CCW cycle)
const unsigned long BRUSH_COAST_MS =
    500; // Coast time between direction changes (prevents back-EMF spike)
const int BRUSH_TOTAL_CYCLES =
    10; // Safety cap — time (serviceDuration) is the primary stopper
const int BRUSH_MOTOR_SPEED = 255;     // Motor speed (0-255)
int brushCurrentCycle = 0;             // Current brush cycle (1-3)
unsigned long brushPhaseStartTime = 0; // When current brush phase started
int brushNextPhase = 0; // Phase to enter after coast transition (phase 6)

/* ===================== DHT22 TEMPERATURE & HUMIDITY SENSOR
 * ===================== */
#define DHT_PIN 9
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

float currentTemperature = 0.0;
float currentHumidity = 0.0;
unsigned long lastDHTRead = 0;
const unsigned long DHT_READ_INTERVAL = 5000; // Read every 5 seconds

/* ===================== JSN-SR20-Y1 ULTRASONIC DISTANCE SENSORS
 * ===================== */
// Sensor 1: Atomizer Level
#define ATOMIZER_TRIG_PIN 10
#define ATOMIZER_ECHO_PIN 11

// Sensor 2: Foam Level
#define FOAM_TRIG_PIN 12
#define FOAM_ECHO_PIN 13

int currentAtomizerDistance = 0; // Atomizer liquid level in cm
int currentFoamDistance = 0;     // Foam level in cm
unsigned long lastUltrasonicRead = 0;
const unsigned long ULTRASONIC_READ_INTERVAL = 5000; // Read every 5 seconds

/* ===================== SERVO MOTORS (MG995) - TWO SERVOS =====================
 */
#define SERVO_LEFT_PIN 19  // GPIO 19 for left servo (0° → 180°)
#define SERVO_RIGHT_PIN 14 // GPIO 14 for right servo (180° → 0°)

Servo servoLeft;  // Left servo: moves from 0° to 180°
Servo servoRight; // Right servo: moves from 180° to 0° (mirrored)

int currentLeftPosition = 0; // Current position of left servo (0-180)
int currentRightPosition =
    180;                    // Current position of right servo (starts at 180)
int targetLeftPosition = 0; // Target position for left servo
int targetRightPosition = 180; // Target position for right servo
bool servosMoving = false;     // Are servos currently moving
unsigned long lastServoUpdate = 0;
const unsigned long SERVO_UPDATE_INTERVAL =
    15; // Update servos every 15ms for smooth movement

// Servo speed control for cleaning brushing phases
// Slow: dynamically calculated at brushing start — 180° sweep over the full
// remaining service time (e.g. 285s → interval ≈ 105, 120s → interval ≈ 44).
// SERVO_SLOW_STEP_INTERVAL is the fallback default (≈285s / 15ms / 180 ≈ 105).
// Fast: 180° over ~2s = move 1° every update
const int SERVO_SLOW_STEP_INTERVAL =
    105; // Fallback default (overridden dynamically at brushing start)
const int SERVO_FAST_STEP_INTERVAL =
    1; // Updates between each 1° step (fast return)
int servoStepInterval = SERVO_SLOW_STEP_INTERVAL; // Current step interval
int servoStepCounter = 0;                         // Counter for step interval

// Forward declarations for functions defined later in the file
void setServoPositions(int leftPos, bool fastMode = false);
void startService(String shoeType, String serviceType, String careType,
                  unsigned long customDurationSeconds = 0);
void stopService();

/* ===================== DRV8871 DC MOTOR DRIVERS - DUAL MOTORS
 * ===================== */
// Left DC Motor
#define MOTOR_LEFT_IN1_PIN 21 // GPIO 21 - Left motor IN1
#define MOTOR_LEFT_IN2_PIN 47 // GPIO 47 - Left motor IN2

// Right DC Motor
#define MOTOR_RIGHT_IN1_PIN 48 // GPIO 48 - Right motor IN1
#define MOTOR_RIGHT_IN2_PIN 45 // GPIO 45 - Right motor IN2

// PWM configuration for motor speed control
const int MOTOR_PWM_FREQ = 1000;    // 1kHz PWM frequency
const int MOTOR_PWM_RESOLUTION = 8; // 8-bit resolution (0-255)

int currentLeftMotorSpeed =
    0; // Left motor speed (-255 to 255, negative = reverse)
int currentRightMotorSpeed =
    0; // Right motor speed (-255 to 255, negative = reverse)

/* ===================== TB6600 STEPPER MOTOR DRIVER - TOP LINEAR STEPPER
 * ===================== */
#define STEPPER1_STEP_PIN 36 // GPIO 36 - STEP/PULSE pin (PUL+/PUL-)
#define STEPPER1_DIR_PIN 35  // GPIO 35 - DIRECTION pin (DIR+/DIR-)
// ENA+ hardwired to GND (motor ALWAYS ENABLED - no ESP32 control needed)

// Top Linear Stepper configuration - Optimized for NEMA11 linear actuator (max
// 80mm/s)
const int STEPPER1_STEPS_PER_REV =
    200; // NEMA11: 1.8° step angle = 200 steps/rev (FULL STEP)
const int STEPPER1_MICROSTEPS =
    1; // TB6600 FULL STEP mode (fastest, set DIP: OFF-OFF-OFF)
const int STEPPER1_STEPS_PER_MM =
    10; // Lead screw: 20mm pitch (200 steps = 20mm travel)
const int STEPPER1_MAX_SPEED = 800; // Maximum: 800 steps/sec = 80mm/s
const unsigned long STEPPER1_MIN_PULSE_WIDTH =
    2; // Minimum 2us pulse (optimized for speed)

// Top Linear Stepper state
long currentStepper1Position = 0; // Current position in steps
long targetStepper1Position = 0;  // Target position in steps
int stepper1Speed =
    800; // Speed: 800 steps/sec = 80mm/s (MAXIMUM for this motor!)
bool stepper1Moving = false; // Is stepper currently moving
unsigned long lastStepper1Update = 0;
unsigned long stepper1StepInterval =
    1250; // Microseconds between steps (calculated from speed)

/* ===================== TB6600 STEPPER MOTOR DRIVER - SIDE LINEAR STEPPER
 * (DOUBLE) ===================== */
#define STEPPER2_STEP_PIN 37 // GPIO 37 - STEP/PULSE pin (PUL+/PUL-)
#define STEPPER2_DIR_PIN 38  // GPIO 38 - DIRECTION pin (DIR+/DIR-)
// ENA+ hardwired to GND (motor ALWAYS ENABLED - no ESP32 control needed)

// Mini Linear Rail Guide Slide Actuator Specifications:
// - Material: Aluminium alloy
// - Effective Travel: 100mm
// - Screw Rod Diameter: 6mm
// - Helical Pitch (Lead): 1mm per revolution
// - Step Angle: 1.8° (200 steps/revolution)
// - Steps per mm: 200 (1mm pitch ÷ 200 steps = 0.005mm per step)
// - Max Speed: 120mm/s = 24,000 steps/sec
// - Current: 0.6A
// - Holding Torque: 6N.cm
const int STEPPER2_STEPS_PER_REV = 200;   // 1.8° step angle = 200 steps/rev
const int STEPPER2_MICROSTEPS = 1;        // TB6600 FULL STEP mode (fastest)
const int STEPPER2_STEPS_PER_MM = 200;    // 1mm lead screw pitch = 200 steps/mm
const int STEPPER2_MAX_SPEED = 24000;     // Maximum: 24,000 steps/sec = 120mm/s
const long STEPPER2_MAX_POSITION = 20000; // 100mm * 200 steps/mm = 20,000 steps
const unsigned long STEPPER2_MIN_PULSE_WIDTH =
    2; // Minimum 2us pulse (optimized for speed)

// Side Linear Stepper (Double) state
long currentStepper2Position = 0; // Current position in steps
long targetStepper2Position = 0;  // Target position in steps
int stepper2Speed = 1500;         // Default: 1500 steps/sec = 7.5mm/s
bool stepper2Moving = false;      // Is stepper currently moving
unsigned long lastStepper2Update = 0;
unsigned long stepper2StepInterval =
    667; // Microseconds between steps (calculated from speed)

/* ===================== WS2812B RGB LED STRIP (NeoPixel) =====================
 */
#define RGB_DATA_PIN 39 // GPIO 39 - WS2812B data pin
#define RGB_NUM_LEDS 58 // Number of LEDs in the strip

// Create NeoPixel strip object
Adafruit_NeoPixel strip(RGB_NUM_LEDS, RGB_DATA_PIN, NEO_GRB + NEO_KHZ800);

// Current color values
int currentRed = 0;
int currentGreen = 0;
int currentBlue = 0;

/* ===================== PAIRING ===================== */
String pairingCode = "";
String deviceId = "";
String groupToken = ""; // 8 hex chars — shared secret for 3-way binding
bool isPaired = false;

/* ===================== BACKEND URL ===================== */
// ============================================================
// ⚠ CHANGE BEFORE FLASHING — Set to 1 for local, 0 for production
#define USE_LOCAL_BACKEND 0
// ============================================================

#if USE_LOCAL_BACKEND
#define BACKEND_HOST_STR "192.168.43.147"
#define BACKEND_PORT_NUM 3000
#define BACKEND_URL_STR "http://192.168.43.147:3000"
#else
#define BACKEND_HOST_STR "smart-shoe-care-machine.onrender.com"
#define BACKEND_PORT_NUM 443
#define BACKEND_URL_STR "https://smart-shoe-care-machine.onrender.com"
#endif

const char *BACKEND_HOST = BACKEND_HOST_STR;
const int BACKEND_PORT = BACKEND_PORT_NUM;
const char *BACKEND_URL = BACKEND_URL_STR;

/* ===================== FUNCTIONS ===================== */

/* ===================== FIRMWARE LOGGING ===================== */
// Sends a log message to the backend via WebSocket → broadcast to kiosk browser
// console. level: "info", "warn", "error" Only sends if WS is connected.
// Serial.println still handled by SSCM_DEBUG guard elsewhere.
void wsLog(const char *level, const String &msg) {
  if (!wsConnected || deviceId.length() == 0)
    return;
  // Escape msg for JSON — backslash must be first to avoid double-escaping
  String safe = msg;
  safe.replace("\\", "\\\\");
  safe.replace("\"", "\\\"");
  safe.replace("\n", "\\n");
  safe.replace("\r", "\\r");
  String payload = "{\"type\":\"firmware-log\",\"deviceId\":\"" + deviceId +
                   "\",\"level\":\"" + String(level) + "\",\"message\":\"" +
                   safe + "\"}";
  webSocket.sendTXT(payload);
}

/* ===================== GROUP TOKEN ===================== */

// Generate an 8-character uppercase hex groupToken from RNG
String generateGroupToken() {
  uint32_t r1 = esp_random();
  uint32_t r2 = esp_random();
  char token[9];
  snprintf(token, sizeof(token), "%08X", r1 ^ ((r2 << 16) | (r2 >> 16)));
  return String(token);
}

/* ===================== ESP-NOW FUNCTIONS ===================== */

// Send callback (ESP32 Arduino Core v3.x)
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Send failed");
#endif
  }
}

// Receive callback — handles PairingAck and CamMessage from CAM
// Updated for ESP32 Arduino Core v3.x
void onDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data,
                int len) {
  if (len < 1)
    return;

  uint8_t msgType = data[0];
  uint8_t *senderMac = recv_info->src_addr;

#if SSCM_DEBUG
  Serial.printf("\n[ESP-NOW] Data received, type=%d len=%d\n", msgType, len);
#endif

  // ============================================================
  // PAIRING ACK (type 2): CAM accepted our pairing broadcast
  // ============================================================
  if (msgType == CAM_MSG_PAIR_ACK) {
    if (len < (int)sizeof(PairingAck)) {
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] PairingAck too small: " + String(len));
#endif
      return;
    }

    PairingAck ack;
    memcpy(&ack, data, sizeof(PairingAck));

#if SSCM_DEBUG
    Serial.println("[ESP-NOW] PairingAck received:");
    Serial.println("  CAM Device ID: " + String(ack.camOwnDeviceId));
    Serial.println("  CAM IP:        " +
                   String(strlen(ack.camIp) > 0 ? ack.camIp : "(no IP yet)"));
#endif

    // Store/update CAM device ID
    pairedCamDeviceId = String(ack.camOwnDeviceId);
    prefs.putString("camDeviceId", pairedCamDeviceId);

    // Store CAM IP if provided
    if (strlen(ack.camIp) > 0) {
      pairedCamIp = String(ack.camIp);
      prefs.putString("camIp", pairedCamIp);
    }

    // MAC-lock to this CAM (first time only)
    if (!camMacPaired) {
      memcpy(camMacAddress, senderMac, 6);
      prefs.putBytes("camMac", camMacAddress, 6);
      camMacPaired = true;

#if SSCM_DEBUG
      Serial.printf(
          "[ESP-NOW] Locked to CAM MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
          camMacAddress[0], camMacAddress[1], camMacAddress[2],
          camMacAddress[3], camMacAddress[4], camMacAddress[5]);
#endif

      // Switch from broadcast peer to direct CAM MAC
      esp_now_del_peer(broadcastAddress);
      esp_now_peer_info_t peer;
      memset(&peer, 0, sizeof(peer));
      memcpy(peer.peer_addr, camMacAddress, 6);
      peer.channel = 0;
      peer.encrypt = false;
      esp_now_add_peer(&peer);
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] Switched to direct CAM communication");
#endif
    }

    camIsReady = true;
    lastCamHeartbeat =
        millis(); // Reset heartbeat so we don't immediately expire
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] CAM paired and ready");
#endif

    // Defer WS send to loop() — cannot call webSocket.sendTXT() from ESP-NOW
    // callback
    espNowEnqueue(ESPNOW_CAM_PAIRED);
    return;
  }

  // ============================================================
  // CAM CLASSIFICATION RESULT (type 4)
  // ============================================================
  if (msgType == CAM_MSG_CLASSIFY_RESULT) {
    if (len < (int)sizeof(CamMessage)) {
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] CamMessage too small: " + String(len));
#endif
      return;
    }

    CamMessage msg;
    memcpy(&msg, data, sizeof(CamMessage));

    lastCamHeartbeat = millis();
    classificationPending = false; // Result received, clear timeout flag

    // Defer all WS calls to loop() — cannot call webSocket.sendTXT() from
    // ESP-NOW callback
    switch (msg.status) {
    case CAM_STATUS_OK:
#if SSCM_DEBUG
      Serial.println("[Classification] OK: " + String(msg.shoeType) + " (" +
                     String(msg.confidence * 100, 1) + "%)");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_OK, msg.shoeType, msg.confidence);
      break;

    case CAM_STATUS_LOW_CONFIDENCE:
#if SSCM_DEBUG
      Serial.println(
          "[Classification] LOW_CONFIDENCE: " + String(msg.shoeType) + " (" +
          String(msg.confidence * 100, 1) + "%) — below threshold");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "LOW_CONFIDENCE");
      break;

    case CAM_STATUS_BUSY:
#if SSCM_DEBUG
      Serial.println("[Classification] CAM busy — retry later");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAM_BUSY");
      break;

    case CAM_STATUS_TIMEOUT:
#if SSCM_DEBUG
      Serial.println("[Classification] CAM timeout");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_TIMEOUT");
      break;

    case CAM_STATUS_NOT_READY:
#if SSCM_DEBUG
      Serial.println("[Classification] CAM camera not ready");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAMERA_NOT_READY");
      break;

    case CAM_STATUS_API_HANDLED:
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] CAM: Gemini API handled classification");
#endif
      classificationPending = false;
      espNowEnqueue(ESPNOW_API_HANDLED);
      break;

    case CAM_STATUS_ERROR:
    default:
#if SSCM_DEBUG
      Serial.println("[Classification] CAM error");
#endif
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_ERROR");
      break;
    }
    return;
  }

  // ============================================================
  // STATUS PONG (type 6): CAM responded to our ping
  // ============================================================
  if (msgType == CAM_MSG_STATUS_PONG) {
    if (len < (int)sizeof(CamMessage))
      return;
    CamMessage msg;
    memcpy(&msg, data, sizeof(CamMessage));
    lastCamHeartbeat = millis();
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] STATUS_PONG: CAM " +
                   String(msg.status == CAM_STATUS_OK ? "READY" : "NOT_READY"));
#endif
    return;
  }

#if SSCM_DEBUG
  Serial.println("[ESP-NOW] Unknown message type: " + String(msgType));
#endif
}

// Initialize ESP-NOW (call after WiFi.mode is set)
void initESPNow() {
  if (espNowInitialized)
    return;

  if (esp_now_init() != ESP_OK) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Init failed!");
#endif
    return;
  }

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  // Load stored CAM pairing data
  size_t macLen = prefs.getBytes("camMac", camMacAddress, 6);
  if (macLen == 6 && (camMacAddress[0] != 0x00 || camMacAddress[1] != 0x00)) {
    camMacPaired = true;
  }
  pairedCamDeviceId = prefs.getString("camDeviceId", "");
  pairedCamIp = prefs.getString("camIp", "");

  if (pairedCamDeviceId.length() > 0) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Restored CAM ID: " + pairedCamDeviceId +
                   " — pairing broadcast will start after WiFi connects");
#endif
    // pairingBroadcastStarted is set by sendPairingBroadcast() once WiFi
    // confirms connected, ensuring validated credentials are sent to the CAM.
  }

  // Add peer: use direct CAM MAC if known, otherwise broadcast
  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  if (camMacPaired) {
    memcpy(peer.peer_addr, camMacAddress, 6);
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Added paired CAM as peer");
#endif
  } else {
    memcpy(peer.peer_addr, broadcastAddress, 6);
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Added broadcast peer for initial discovery");
#endif
  }
  peer.channel = 0;
  peer.encrypt = false;

  if (esp_now_add_peer(&peer) != ESP_OK) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Failed to add peer");
#endif
    return;
  }

  espNowInitialized = true;
#if SSCM_DEBUG
  Serial.println("[ESP-NOW] Initialized");
#endif
}

// Send pairing broadcast to CAM (replaces old sendCredentialsToCAM)
void sendPairingBroadcast() {
  if (!espNowInitialized)
    return;

  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (ssid.length() == 0) {
    static bool warned = false;
    if (!warned) {
#if SSCM_DEBUG
      Serial.println(
          "[ESP-NOW] No WiFi credentials — cannot send pairing broadcast");
#endif
      warned = true;
    }
    return;
  }

  PairingBroadcast pb;
  memset(&pb, 0, sizeof(pb));
  pb.type = CAM_MSG_PAIR_REQUEST;
  strncpy(pb.groupToken, groupToken.c_str(), sizeof(pb.groupToken) - 1);
  strncpy(pb.deviceId, deviceId.c_str(), sizeof(pb.deviceId) - 1);
  strncpy(pb.ssid, ssid.c_str(), sizeof(pb.ssid) - 1);
  strncpy(pb.password, pass.c_str(), sizeof(pb.password) - 1);
  strncpy(pb.wsHost, BACKEND_HOST, sizeof(pb.wsHost) - 1);
  pb.wsPort = BACKEND_PORT;

  uint8_t *targetMac = camMacPaired ? camMacAddress : broadcastAddress;
  esp_now_send(targetMac, (uint8_t *)&pb, sizeof(pb));

  pairingBroadcastStarted = true;
  lastPairingBroadcastTime = millis();

  static int sendCount = 0;
  sendCount++;
#if SSCM_DEBUG
  Serial.println("[ESP-NOW] Pairing broadcast sent (attempt " +
                 String(sendCount) + ")");
#endif
}

// Send classify request to CAM via ESP-NOW
void sendClassifyRequest() {
  if (!espNowInitialized || !camMacPaired) {
#if SSCM_DEBUG
    Serial.println(
        "[Classification] CAM not paired — cannot send classify request");
#endif
    return;
  }

  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = CAM_MSG_CLASSIFY_REQUEST;
  msg.status = CAM_STATUS_OK;

  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
  classificationPending = true;
  classificationRequestTime = millis();
  wsLog("info", "Classification request sent to CAM via ESP-NOW");
#if SSCM_DEBUG
  Serial.println("[Classification] CLASSIFY_REQUEST sent to CAM via ESP-NOW");
#endif
}

// Send LED control to CAM via ESP-NOW
void sendLedControl(uint8_t ledMsgType) {
  if (!espNowInitialized || !camMacPaired)
    return;

  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = ledMsgType;

  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
#if SSCM_DEBUG
  Serial.println(
      "[ESP-NOW] LED " +
      String(ledMsgType == CAM_MSG_LED_ENABLE ? "ENABLE" : "DISABLE") +
      " sent to CAM");
#endif
}

/* ===================== WIFI FUNCTIONS ===================== */

String getWiFiListHTML() {
  String options = "";
  int n = WiFi.scanNetworks();

  if (n <= 0) {
    options += "<option>No networks found</option>";
  } else {
    for (int i = 0; i < n; i++) {
      String ssid = WiFi.SSID(i);
      int rssi = WiFi.RSSI(i);

      // Sanitize SSID for HTML
      ssid.replace("'", "");
      ssid.replace("\"", "");
      ssid.replace("<", "");
      ssid.replace(">", "");

      options += "<option value='";
      options += ssid;
      options += "'>";
      options += ssid;
      options += " (";
      options += rssi;
      options += " dBm)</option>";
    }
  }

  WiFi.scanDelete();
  return options;
}

void startSoftAP() {
  if (softAPStarted)
    return;

  softAPStarted = true;

  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("Smart Shoe Care Machine Setup");
#if SSCM_DEBUG
  Serial.println("[SoftAP] Open (no password)");
  Serial.println("=== SoftAP Started ===");
  Serial.print("SSID: Smart Shoe Care Machine Setup");
  Serial.print("\nIP: ");
  Serial.println(WiFi.softAPIP());
  Serial.println("======================");
#endif

  wifiServer.begin();
}

String urlDecode(String input) {
  input.replace("+", " ");
  for (int i = 0; i < input.length(); i++) {
    if (input[i] == '%' && i + 2 < input.length()) {
      String hex = input.substring(i + 1, i + 3);
      char ch = strtol(hex.c_str(), NULL, 16);
      input = input.substring(0, i) + ch + input.substring(i + 3);
    }
  }
  return input;
}

void handleWiFiPortal() {
  WiFiClient client = wifiServer.available();
  if (!client)
    return;

  // Wait briefly for client to send request (non-blocking with timeout)
  unsigned long timeout = millis() + 100; // 100ms timeout
  while (!client.available() && millis() < timeout) {
    delay(1);
  }

  // Read the request with a short timeout to prevent blocking the main loop
  client.setTimeout(100); // 100ms max — prevents 1s stall per request
  String request = "";
  if (client.available()) {
    const size_t MAX_REQUEST_SIZE = 2048;
    request = "";
    while (client.available() && request.length() < MAX_REQUEST_SIZE) {
      request += (char)client.read();
    }
    while (client.available())
      client.read();
  }

  // Check POST data
  if (request.indexOf("ssid=") != -1) {
    int ssidIndex = request.indexOf("ssid=") + 5;
    int passIndex = request.indexOf("&pass=");
    if (passIndex == -1) {
      client.stop();
      return;
    }

    String ssid = request.substring(ssidIndex, passIndex);
    String pass = request.substring(passIndex + 6);

    ssid = urlDecode(ssid);
    ssid.trim();
    pass = urlDecode(pass);
    pass.trim();

    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);

    // Build confirmation page with actual SSID (from html_pages.h)
    String confirmPage = FPSTR(CONFIRM_HTML);
    confirmPage.replace("{{SSID}}", ssid);

    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html; charset=UTF-8");
    client.println("Connection: close");
    client.println();
    client.print(confirmPage);
    client.flush();
    client.stop();

    delay(1500);
    ESP.restart();
  }
  // Serve HTML page
  else {
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html");
    client.println("Connection: close");
    client.println();
    String page = WIFI_HTML;
    page.replace("{{WIFI_LIST}}", getWiFiListHTML());
    client.print(page);
  }

  client.stop();
}

String generatePairingCode() {
  String code = "";
  for (int i = 0; i < 6; i++) {
    code += String(esp_random() % 10);
  }
  return code;
}

String generateDeviceId() {
  // Use lower 3 bytes of EfuseMac — device-specific (not OUI) part of the MAC
  uint64_t chipid = ESP.getEfuseMac();
  char id[12];
  snprintf(id, sizeof(id), "SSCM-%02X%02X%02X",
           (uint8_t)((chipid >> 16) & 0xFF), (uint8_t)((chipid >> 8) & 0xFF),
           (uint8_t)((chipid >> 0) & 0xFF));
  return String(id);
}

void sendDeviceRegistration() {
  if (WiFi.status() != WL_CONNECTED)
    return;

  HTTPClient http;
  String url = String(BACKEND_URL) + "/api/device/register";

#if USE_LOCAL_BACKEND
  http.begin(url);
#else
  WiFiClientSecure secureClient;
  // Note: setInsecure() skips TLS certificate verification.
  // For higher security, replace with secureClient.setCACert(CA_CERT_PEM)
  // where CA_CERT_PEM is the Render/hosting root CA certificate.
  secureClient.setInsecure();
  http.begin(secureClient, url);
#endif
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"pairingCode\":\"" + pairingCode + "\"";
  if (groupToken.length() > 0) {
    payload += ",\"groupToken\":\"" + groupToken + "\"";
  }
  payload += "}";

  int httpCode = http.POST(payload);

  if (httpCode == 200 || httpCode == 201) {
    String response = http.getString();
    if (response.indexOf("\"paired\":true") != -1) {
#if SSCM_DEBUG
      Serial.println("[HTTP] Device already paired");
#endif
      isPaired = true;
      prefs.putBool("paired", true);
    }
  } else if (httpCode > 0) {
#if SSCM_DEBUG
    Serial.println("[HTTP] Registration failed: " + String(httpCode));
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[HTTP] Registration error: " +
                   http.errorToString(httpCode));
#endif
  }

  http.end();
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_DISCONNECTED: {
#if SSCM_DEBUG
    Serial.println("[WebSocket] Disconnected");
#endif
    wsConnected = false;
    break;
  }

  case WStype_CONNECTED: {
#if SSCM_DEBUG
    Serial.println("[WebSocket] Connected");
#endif
    wsConnected = true;
    String subscribeMsg =
        "{\"type\":\"subscribe\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(subscribeMsg);
    wsLog("info", "WebSocket connected — IP: " + WiFi.localIP().toString() +
                      ", device: " + deviceId);
    break;
  }

  case WStype_TEXT: {
    // Parse JSON response
    String message = String((char *)payload);

    if (message.indexOf("\"type\":\"subscribed\"") != -1) {
#if SSCM_DEBUG
      Serial.println("[WebSocket] Subscribed");
#endif

      // Send initial status update immediately after subscribing
      String statusMsg =
          "{\"type\":\"status-update\",\"deviceId\":\"" + deviceId + "\"}";
      webSocket.sendTXT(statusMsg);
      // Reset the periodic timer so the next scheduled send starts from now,
      // preventing a double-send burst (immediate + periodic firing right after)
      lastStatusUpdate = millis();

      // Send CAM sync status so frontend knows if CAM is ready
      sendCamSyncStatus();
    } else if (message.indexOf("\"type\":\"status-ack\"") != -1) {
      // Acknowledgment of status update with paired status sync
      if (message.indexOf("\"success\":true") != -1) {

        // Sync paired status from database
        bool dbPaired = (message.indexOf("\"paired\":true") != -1);

        if (dbPaired != isPaired) {
          if (dbPaired && !isPaired) {
            isPaired = true;
            prefs.putBool("paired", true);
          } else if (!dbPaired && isPaired) {
            isPaired = false;
            prefs.putBool("paired", false);
            pairingCode = generatePairingCode();
            sendDeviceRegistration();
          }
        }
      } else {
#if SSCM_DEBUG
        Serial.println("[WebSocket] Status update failed");
#endif
      }
    } else if (message.indexOf("\"type\":\"device-update\"") != -1) {
      if (message.indexOf("\"paired\":true") != -1) {
        if (!isPaired) {
#if SSCM_DEBUG
          Serial.println("[WebSocket] Device paired!");
#endif
          isPaired = true;
          prefs.putBool("paired", true);
          wsLog("info", "Device paired by dashboard");
        }
      } else if (message.indexOf("\"paired\":false") != -1) {
        if (isPaired) {
#if SSCM_DEBUG
          Serial.println("[WebSocket] Device unpaired, restarting...");
#endif
          isPaired = false;
          prefs.putBool("paired", false);
          wsLog("warn", "Device unpaired — restarting");
          delay(500);
          ESP.restart();
        }
      }
    } else if (message.indexOf("\"type\":\"enable-payment\"") != -1) {
#if SSCM_DEBUG
      Serial.println("[PAYMENT] Enabled");
#endif
      paymentEnabled = true;
      paymentEnableTime = millis();
      digitalWrite(RELAY_1_PIN, RELAY_ON);
      relay1State = true;
      wsLog("info", "Payment system enabled");
    } else if (message.indexOf("\"type\":\"disable-payment\"") != -1) {
#if SSCM_DEBUG
      Serial.println("[PAYMENT] Disabled");
#endif
      paymentEnabled = false;
      digitalWrite(RELAY_1_PIN, RELAY_OFF);
      relay1State = false;
      currentCoinPulses = 0;
      currentBillPulses = 0;
      // Flush totals to NVS immediately at end of payment session
      if (totalsDirty) {
        prefs.putUInt("totalCoinPesos", totalCoinPesos);
        prefs.putUInt("totalBillPesos", totalBillPesos);
        lastTotalsSave = millis();
        totalsDirty = false;
      }
      wsLog("info", "Payment system disabled");
    } else if (message.indexOf("\"type\":\"relay-control\"") != -1) {
      // Parse relay control command
      // Expected format: {"type":"relay-control","channel":1,"state":true}
      int channelIndex = message.indexOf("\"channel\":");
      int stateIndex = message.indexOf("\"state\":");

      if (channelIndex != -1 && stateIndex != -1) {
        // Extract channel number
        int channelStart = channelIndex + 10; // length of "\"channel\":"
        int channelEnd = message.indexOf(',', channelStart);
        if (channelEnd == -1)
          channelEnd = message.indexOf('}', channelStart);
        String channelStr = message.substring(channelStart, channelEnd);
        channelStr.trim();
        int channel = channelStr.toInt();

        // Extract state
        int stateStart = stateIndex + 8; // length of "\"state\":"
        int stateEnd = message.indexOf('}', stateStart);
        String stateStr = message.substring(stateStart, stateEnd);
        stateStr.trim();
        bool state = (stateStr.indexOf("true") != -1);

        // Set the relay
        if (channel >= 1 && channel <= 8) {
          setRelay(channel, state);
#if SSCM_DEBUG
          Serial.println("[WebSocket] Relay CH" + String(channel) + " -> " +
                         (state ? "ON" : "OFF"));
#endif
        } else {
#if SSCM_DEBUG
          Serial.println("[WebSocket] Invalid relay CH" + String(channel));
#endif
        }
      } else {
#if SSCM_DEBUG
        Serial.println("[WebSocket] Bad relay format");
#endif
      }
    } else if (message.indexOf("\"type\":\"start-service\"") != -1) {
      // Parse start-service command
      // Expected format:
      // {"type":"start-service","deviceId":"xxx","shoeType":"mesh","serviceType":"drying","careType":"normal"}

      // Extract shoeType
      int shoeTypeIndex = message.indexOf("\"shoeType\":\"");
      String shoeType = "";
      if (shoeTypeIndex != -1) {
        int start = shoeTypeIndex + 12; // length of "\"shoeType\":\""
        int end = message.indexOf("\"", start);
        shoeType = message.substring(start, end);
      }

      // Extract serviceType
      int serviceTypeIndex = message.indexOf("\"serviceType\":\"");
      String serviceType = "";
      if (serviceTypeIndex != -1) {
        int start = serviceTypeIndex + 15; // length of "\"serviceType\":\""
        int end = message.indexOf("\"", start);
        serviceType = message.substring(start, end);
      }

      // Extract careType
      int careTypeIndex = message.indexOf("\"careType\":\"");
      String careType = "";
      if (careTypeIndex != -1) {
        int start = careTypeIndex + 12; // length of "\"careType\":\""
        int end = message.indexOf("\"", start);
        careType = message.substring(start, end);
      }

      // Extract optional custom duration (seconds)
      unsigned long customDuration = 0;
      int durationIndex = message.indexOf("\"duration\":");
      if (durationIndex != -1) {
        int start = durationIndex + 11;
        int end = message.indexOf(",", start);
        if (end == -1)
          end = message.indexOf("}", start);
        customDuration = message.substring(start, end).toInt();
      }

      // Start the service (handles all service types: cleaning, drying,
      // sterilizing)
      if (serviceType == "cleaning" || serviceType == "drying" ||
          serviceType == "sterilizing") {
        startService(shoeType, serviceType, careType, customDuration);
        wsLog("info",
              "Service started: " + serviceType + " | shoe: " + shoeType +
                  " | care: " + careType +
                  (customDuration > 0 ? " | " + String(customDuration) + "s"
                                      : ""));
#if SSCM_DEBUG
        Serial.println(
            "[WebSocket] Start: " + serviceType + " | " + shoeType + " | " +
            careType +
            (customDuration > 0 ? " | " + String(customDuration) + "s" : ""));
#endif
      } else {
#if SSCM_DEBUG
        Serial.println("[WebSocket] Unknown service: " + serviceType);
#endif
      }
    } else if (message.indexOf("\"type\":\"start-classification\"") != -1) {
      // Tablet/backend requesting classification — send to CAM via ESP-NOW
#if SSCM_DEBUG
      Serial.println("\n=== CLASSIFICATION REQUESTED (via ESP-NOW) ===");
#endif
      if (camIsReady && camMacPaired) {
        sendClassifyRequest();
      } else {
#if SSCM_DEBUG
        Serial.println("[Classification] CAM not ready — aborting");
#endif
        relayClassificationErrorToBackend("CAM_NOT_READY");
      }
#if SSCM_DEBUG
      Serial.println("==============================================\n");
#endif
    } else if (message.indexOf("\"type\":\"enable-classification\"") != -1) {
      // User entered classification page — turn on WHITE LED + notify CAM
#if SSCM_DEBUG
      Serial.println("\n=== CLASSIFICATION PAGE ENTERED ===");
#endif
      rgbWhite();
      classificationLedOn = true;
      sendLedControl(CAM_MSG_LED_ENABLE);
#if SSCM_DEBUG
      Serial.println("RGB Light: WHITE (camera lighting)");
      Serial.println("===================================\n");
#endif
    } else if (message.indexOf("\"type\":\"disable-classification\"") != -1) {
      // User left classification page — turn off LED + notify CAM
#if SSCM_DEBUG
      Serial.println("\n=== CLASSIFICATION PAGE EXITED ===");
#endif
      rgbOff();
      classificationLedOn = false;
      sendLedControl(CAM_MSG_LED_DISABLE);
#if SSCM_DEBUG
      Serial.println("RGB Light: OFF");
      Serial.println("==================================\n");
#endif
    } else if (message.indexOf("\"type\":\"restart-device\"") != -1) {
      // Restart command from admin panel
#if SSCM_DEBUG
      Serial.println("\n=== RESTART COMMAND RECEIVED ===");
      Serial.println("Restarting device in 2 seconds...");
      Serial.println("================================\n");
#endif
      delay(2000);
      ESP.restart();
    } else if (message.indexOf("\"type\":\"serial-command\"") != -1) {
      int cmdIndex = message.indexOf("\"command\":\"");
      if (cmdIndex != -1) {
        int cmdStart = cmdIndex + 11; // length of "\"command\":\""
        int cmdEnd = message.indexOf("\"", cmdStart);
        if (cmdEnd != -1) {
          String serialCmd = message.substring(cmdStart, cmdEnd);
          serialCmd.trim();
          if (serialCmd.length() > 0 && serialCmd.length() <= 256) {
            wsLog("info", "WS cmd: " + serialCmd);
            handleSerialCommand(serialCmd);
          }
        }
      }
    }
    break;
  }

  case WStype_ERROR: {
#if SSCM_DEBUG
    Serial.println("[WebSocket] Error");
#endif
    wsConnected = false;
    break;
  }
  }
}

void connectWebSocket() {
  if (!wifiConnected)
    return;

  // begin() must only be called once — the library's setReconnectInterval
  // handles all subsequent reconnects internally. Calling begin() again resets
  // the library state and conflicts with its built-in reconnect logic, causing
  // the first-boot connection failure.
  if (wsInitialized)
    return;

  String wsPath = "/api/ws?deviceId=" + deviceId;
  if (groupToken.length() > 0) {
    wsPath += "&groupToken=" + groupToken;
  }

#if SSCM_DEBUG
  Serial.println("[WebSocket] Connecting to " + String(BACKEND_HOST) + ":" +
                 String(BACKEND_PORT));
#endif
#if USE_LOCAL_BACKEND
  webSocket.begin(BACKEND_HOST, BACKEND_PORT, wsPath);
#else
  webSocket.beginSSL(BACKEND_HOST, BACKEND_PORT, wsPath);
#endif
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(WS_RECONNECT_INTERVAL);
  // Heartbeat: send a WS-level ping every 15s to keep Render's proxy from
  // killing idle SSL connections. Without this, Render drops the connection
  // silently (no WStype_ERROR, just WStype_DISCONNECTED) during the TLS idle
  // window, causing the constant reconnect loop seen in production.
  webSocket.enableHeartbeat(15000, 3000, 2);
  wsInitialized = true;
}

void connectWiFi() {
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (ssid.length() == 0) {
#if SSCM_DEBUG
    Serial.println("No WiFi credentials found");
#endif
    startSoftAP();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  wifiStartTime = millis();

#if SSCM_DEBUG
  Serial.println("=== Connecting to WiFi ===");
  Serial.println("SSID: " + ssid);
  Serial.println("==========================");
#endif
}

/* ===================== RELAY CONTROL FUNCTIONS ===================== */
void setRelay(int channel, bool state) {
  int pin;
  bool *stateVar;
  String name;

  switch (channel) {
  case 1:
    pin = RELAY_1_PIN;
    stateVar = &relay1State;
    name = "Bill Acceptor";
    break;
  case 2:
    pin = RELAY_2_PIN;
    stateVar = &relay2State;
    name = "Bottom Exhaust";
    break;
  case 3:
    pin = RELAY_3_PIN;
    stateVar = &relay3State;
    name = "Centrifugal Blower Fan";
    break;
  case 4:
    pin = RELAY_4_PIN;
    stateVar = &relay4State;
    name = "Left PTC Heater";
    break;
  case 5:
    pin = RELAY_5_PIN;
    stateVar = &relay5State;
    name = "Diaphragm Pump";
    break;
  case 6:
    pin = RELAY_6_PIN;
    stateVar = &relay6State;
    name = "Right PTC Heater";
    break;
  case 7:
    pin = RELAY_7_PIN;
    stateVar = &relay7State;
    name = "Atomizer + Mist Fan";
    break;
  case 8:
    pin = RELAY_8_PIN;
    stateVar = &relay8State;
    name = "UVC Light";
    break;
  default:
#if SSCM_DEBUG
    Serial.println("[ERROR] Invalid relay channel: " + String(channel));
#endif
    return;
  }

  *stateVar = state;
  digitalWrite(pin, state ? RELAY_ON : RELAY_OFF);

  // Relay 1 switching creates inductive EMI that can disturb servo PWM signals.
  // Re-asserting the current servo positions immediately after the switch
  // overrides any EMI-induced displacement before the servo can react.
  if (channel == 1) {
    servoLeft.write(currentLeftPosition);
    servoRight.write(currentRightPosition);
  }

#if SSCM_DEBUG
  Serial.println("[Relay " + String(channel) + "] " + name + ": " +
                 (state ? "ON" : "OFF"));
#endif
}

void allRelaysOff() {
#if SSCM_DEBUG
  Serial.println("\n=== Turning All Relays OFF ===");
#endif
  for (int i = 1; i <= 8; i++) {
    setRelay(i, false);
  }
#if SSCM_DEBUG
  Serial.println("===============================\n");
#endif
}

/* ===================== SERVICE FUNCTIONS ===================== */
void startService(String shoeType, String serviceType, String careType,
                  unsigned long customDurationSeconds) {
  // Turn OFF all service-related relays and RGB before starting new service
  // This ensures clean transition between services in auto mode
  if (serviceActive) {
#if SSCM_DEBUG
    Serial.println("[Service] Completing previous service: " +
                   currentServiceType);
#endif

    // Send completion message for the previous service
    if (wsConnected && isPaired) {
      String msg = "{";
      msg += "\"type\":\"service-complete\",";
      msg += "\"deviceId\":\"" + deviceId + "\",";
      msg += "\"serviceType\":\"" + currentServiceType + "\",";
      msg += "\"shoeType\":\"" + currentShoeType + "\",";
      msg += "\"careType\":\"" + currentCareType + "\"";
      msg += "}";
      webSocket.sendTXT(msg);
      wsLog("info", "Service complete: " + currentServiceType + " | shoe: " +
                        currentShoeType + " | care: " + currentCareType);
#if SSCM_DEBUG
      Serial.println("[WebSocket] Sent completion for: " + currentServiceType);
#endif
    }

    // Turn off RGB
    rgbOff();
    // Turn off all service relays (CH3-CH8)
    setRelay(2, false); // Bottom Exhaust
    setRelay(3, false); // Blower Fan
    setRelay(4, false); // Left PTC Heater
    setRelay(5, false); // Diaphragm Pump
    setRelay(6, false); // Right PTC Heater
    setRelay(7, false); // Atomizer + Mist Fan
    setRelay(8, false); // UVC Light

    // Reset service-specific state
    if (currentServiceType == "cleaning") {
      setRelay(5, false); // Pump OFF
      cleaningPhase = 0;
      brushCurrentCycle = 0;
      stepper1MoveTo(0);
      stepper2MoveTo(0);
      motorsCoast();
#if SSCM_DEBUG
      Serial.println(
          "[Service] Cleaning state reset, steppers/motors returning to home");
#endif
    }
  }

  // Determine duration based on service and care type (in milliseconds)
  if (serviceType == "cleaning") {
    serviceDuration =
        300000; // Cleaning always 300 seconds (5 minutes) for all care types
  } else if (serviceType == "drying") {
    if (careType == "gentle") {
      serviceDuration = 60000; // 60 seconds (1 minute)
    } else if (careType == "normal") {
      serviceDuration = 180000; // 180 seconds (3 minutes)
    } else if (careType == "strong") {
      serviceDuration = 300000; // 300 seconds (5 minutes)
    } else {
      serviceDuration = 180000; // Default to normal (180 seconds)
    }
  } else if (serviceType == "sterilizing") {
    if (careType == "gentle") {
      serviceDuration = 60000; // 60 seconds (1 minute)
    } else if (careType == "normal") {
      serviceDuration = 180000; // 180 seconds (3 minutes)
    } else if (careType == "strong") {
      serviceDuration = 300000; // 300 seconds (5 minutes)
    } else {
      serviceDuration = 180000; // Default to normal (180 seconds)
    }
  } else {
    serviceDuration = 180000; // Default to 180 seconds
  }

  // Override with custom duration from frontend if provided
  if (customDurationSeconds > 0) {
    serviceDuration = customDurationSeconds * 1000;
#if SSCM_DEBUG
    Serial.println(
        "[Service] Custom duration: " + String(customDurationSeconds) + "s");
#endif
  }

  currentShoeType = shoeType;
  currentServiceType = serviceType;
  currentCareType = careType;
  serviceActive = true;
  serviceStartTime = millis();
  lastServiceStatusUpdate = millis();

#if SSCM_DEBUG
  Serial.println("\n=== SERVICE STARTED ===");
  Serial.print("Shoe Type: ");
  Serial.println(shoeType);
  Serial.print("Service Type: ");
  Serial.println(serviceType);
  Serial.print("Care Type: ");
  Serial.println(careType);
  Serial.print("Duration: ");
  Serial.print(serviceDuration / 1000);
  Serial.println(" seconds");
#endif

  // Set RGB light color based on service type
  if (serviceType == "cleaning") {
    rgbBlue(); // Blue for cleaning
#if SSCM_DEBUG
    Serial.println("RGB Light: BLUE");
#endif
  } else if (serviceType == "drying") {
    rgbGreen(); // Green for drying
#if SSCM_DEBUG
    Serial.println("RGB Light: GREEN");
#endif
  } else if (serviceType == "sterilizing") {
    rgbPink(); // Pink for sterilizing
#if SSCM_DEBUG
    Serial.println("RGB Light: PINK");
#endif
  }

  // Turn ON relays based on service type
  if (serviceType == "cleaning") {
    setRelay(5, true); // Diaphragm Pump ON
#if SSCM_DEBUG
    Serial.println("Relay 5 (Pump): ON");
#endif

    // Side linear moves to designated position immediately
    long stepper2TargetSteps = 0;
    if (careType == "strong") {
      stepper2TargetSteps = 20000; // 100mm (STEPPER2_MAX_POSITION)
    } else if (careType == "normal") {
      stepper2TargetSteps = 19600; // 98mm
    } else if (careType == "gentle") {
      stepper2TargetSteps = 18600; // 93mm
    } else {
      stepper2TargetSteps = 19600; // Default normal
    }
    stepper2MoveTo(stepper2TargetSteps);
#if SSCM_DEBUG
    Serial.print("[Cleaning] Side linear moving to ");
    Serial.print(stepper2TargetSteps / 200);
    Serial.print("mm (");
    Serial.print(careType);
    Serial.println(" care)");
#endif

    // Phase 1: 3s pump delay before top linear starts
    cleaningPhase = 1;
    brushPhaseStartTime = millis();
#if SSCM_DEBUG
    Serial.println(
        "[Cleaning] Phase 1: Pump ON, waiting 3s before top linear starts");
#endif
  } else if (serviceType == "drying") {
    setRelay(3, true); // Centrifugal Blower Fan ON (always on during drying)
    setRelay(4,
             true); // Left PTC Heater ON (temperature control will manage it)
    setRelay(6,
             true); // Right PTC Heater ON (temperature control will manage it)
    dryingHeaterOn = true;
    dryingExhaustOn = false;
#if SSCM_DEBUG
    Serial.println("Relay 3 (Blower Fan): ON");
    Serial.println("Relay 4 (Left PTC Heater): ON");
    Serial.println("Relay 6 (Right PTC Heater): ON");
    Serial.println(
        "[Drying] Temperature control active: " + String(DRYING_TEMP_LOW, 0) +
        "–" + String(DRYING_TEMP_HIGH, 0) + "°C");
#endif
  } else if (serviceType == "sterilizing") {
    setRelay(8, true); // UVC ON
    setRelay(7, true); // Atomizer + Mist Fan ON
#if SSCM_DEBUG
    Serial.println("[Sterilize] UVC + Atomizer+Fan ON (full duration)");
#endif
  }

#if SSCM_DEBUG
  Serial.println("=======================\n");
#endif

  // Send service started confirmation via WebSocket
  sendServiceStatusUpdate();
}

void stopService() {
  if (!serviceActive)
    return;

  serviceActive = false;

  // Turn OFF RGB light
  rgbOff();
#if SSCM_DEBUG
  Serial.println("RGB Light: OFF");
#endif

  // Turn OFF relays based on service type
  if (currentServiceType == "cleaning") {
    setRelay(5, false); // Diaphragm Pump (safety — may already be off)
    cleaningPhase = 0;
    brushCurrentCycle = 0;
    stepper1MoveTo(0);
#if SSCM_DEBUG
    Serial.println("[Cleaning] Returning top linear to home position");
#endif
    stepper2MoveTo(0);
#if SSCM_DEBUG
    Serial.println("[Cleaning] Returning side linear to home position");
#endif
    // Stop brush motors
    motorsCoast();
#if SSCM_DEBUG
    Serial.println("[Cleaning] Brush motors stopped");
#endif
    // Reset servos to original position (fast return)
    setServoPositions(0, true); // Left: 0°, Right: 180°
#if SSCM_DEBUG
    Serial.println("[Cleaning] Resetting servos to home position");
#endif
  } else if (currentServiceType == "drying") {
    setRelay(3, false); // Centrifugal Blower Fan
    setRelay(4, false); // Left PTC Heater
    setRelay(6, false); // Right PTC Heater
    setRelay(2, false); // Ensure exhaust OFF before purge takes over
    dryingHeaterOn = false;
    dryingExhaustOn = false;
    // Start purge: exhaust ON for 15s to cool down chamber
    setRelay(2, true);
    purgeActive = true;
    purgeStartTime = millis();
    purgeServiceType = currentServiceType;
    purgeShoeType = currentShoeType;
    purgeCareType = currentCareType;
#if SSCM_DEBUG
    Serial.println("[Purge] Drying purge started - Bottom Exhaust ON for 15s");
#endif
  } else if (currentServiceType == "sterilizing") {
    setRelay(7, false); // Atomizer + Mist Fan
    setRelay(8, false); // UVC Light
    // Start purge: exhaust ON for 15s to clear residual mist
    setRelay(2, true);
    purgeActive = true;
    purgeStartTime = millis();
    purgeServiceType = currentServiceType;
    purgeShoeType = currentShoeType;
    purgeCareType = currentCareType;
#if SSCM_DEBUG
    Serial.println(
        "[Purge] Sterilizing purge started - Bottom Exhaust ON for 15s");
#endif
  }

#if SSCM_DEBUG
  Serial.println("\n=== SERVICE STOPPED ===");
  Serial.println("Service Type: " + currentServiceType);
  Serial.println("=======================\n");
#endif

  // Send service-complete immediately for all services — purge runs in
  // background
  if (wsConnected && isPaired) {
    String msg = "{";
    msg += "\"type\":\"service-complete\",";
    msg += "\"deviceId\":\"" + deviceId + "\",";
    msg += "\"serviceType\":\"" + currentServiceType + "\",";
    msg += "\"shoeType\":\"" + currentShoeType + "\",";
    msg += "\"careType\":\"" + currentCareType + "\"";
    msg += "}";
    webSocket.sendTXT(msg);
#if SSCM_DEBUG
    Serial.println("[WebSocket] Complete: " + currentServiceType);
#endif
  }

  // Clear service data
  currentShoeType = "";
  currentServiceType = "";
  currentCareType = "";
}

void handlePurge() {
  if (!purgeActive)
    return;

  if (millis() - purgeStartTime >= PURGE_DURATION_MS) {
    purgeActive = false;
    setRelay(2, false); // Bottom Exhaust OFF
#if SSCM_DEBUG
    Serial.println("[Purge] Complete - Bottom Exhaust OFF");
#endif

    purgeServiceType = "";
    purgeShoeType = "";
    purgeCareType = "";
  }
}

void handleDryingTemperature() {
  if (!serviceActive || currentServiceType != "drying")
    return;
  if (currentTemperature <= 0.0)
    return; // No valid reading yet

  if (currentTemperature < DRYING_TEMP_LOW) {
    // Too cold — heaters ON, exhaust OFF
    if (!dryingHeaterOn) {
      setRelay(4, true); // Left PTC Heater
      setRelay(6, true); // Right PTC Heater
      dryingHeaterOn = true;
#if SSCM_DEBUG
      Serial.println("[Drying] Temp " + String(currentTemperature, 1) +
                     "°C < " + String(DRYING_TEMP_LOW, 0) + "°C — Heaters ON");
#endif
    }
    if (dryingExhaustOn) {
      setRelay(2, false);
      dryingExhaustOn = false;
#if SSCM_DEBUG
      Serial.println("[Drying] Exhaust OFF");
#endif
    }
  } else if (currentTemperature > DRYING_TEMP_HIGH) {
    // Too hot — heaters OFF, exhaust ON to release heat
    if (dryingHeaterOn) {
      setRelay(4, false); // Left PTC Heater
      setRelay(6, false); // Right PTC Heater
      dryingHeaterOn = false;
#if SSCM_DEBUG
      Serial.println("[Drying] Temp " + String(currentTemperature, 1) +
                     "°C > " + String(DRYING_TEMP_HIGH, 0) +
                     "°C — Heaters OFF");
#endif
    }
    if (!dryingExhaustOn) {
      setRelay(2, true);
      dryingExhaustOn = true;
#if SSCM_DEBUG
      Serial.println("[Drying] Exhaust ON (cooling)");
#endif
    }
  }
  // Within 35–40°C band: hold current state (hysteresis)
}

void handleService() {
  if (!serviceActive)
    return;

  unsigned long elapsed = millis() - serviceStartTime;

  // Check if service duration is complete — stop immediately for all services
  if (elapsed >= serviceDuration) {
#if SSCM_DEBUG
    Serial.println("[Service] Duration elapsed (" + String(elapsed / 1000) +
                   "s) — stopping immediately");
#endif
    stopService();
    return;
  }

  // Handle cleaning mode phases
  if (currentServiceType == "cleaning" && cleaningPhase > 0) {

    // Phase 1: Pump ON + side linear moving — wait 3s then start top linear
    if (cleaningPhase == 1) {
      if (millis() - brushPhaseStartTime >= CLEANING_PUMP_DELAY_MS) {
        cleaningPhase = 2;
        stepper1MoveTo(CLEANING_MAX_POSITION);
#if SSCM_DEBUG
        Serial.print("[Cleaning] Phase 2: Top linear moving to ");
        Serial.print(CLEANING_MAX_POSITION / 10);
        Serial.println("mm");
#endif
      }
    }

    // Phase 2: Top linear moving forward to max
    else if (cleaningPhase == 2) {
      if (!stepper1Moving) {
        cleaningPhase = 3;
        stepper1MoveTo(0);
#if SSCM_DEBUG
        Serial.println("[Cleaning] Phase 3: Top linear returning to home");
#endif
      }
    }

    // Phase 3: Top linear returning to home
    else if (cleaningPhase == 3) {
      if (!stepper1Moving) {
        // Top linear home — pump OFF, start brushing
        setRelay(5, false); // Diaphragm Pump OFF
#if SSCM_DEBUG
        Serial.println("[Cleaning] Top linear at home - Pump OFF");
#endif
        cleaningPhase = 4;
        brushCurrentCycle = 1;
        brushPhaseStartTime = millis();
        setMotorsSameSpeed(BRUSH_MOTOR_SPEED); // Start CW

        // Servo sweeps 0° → 180° over exactly the remaining service time
        // so it arrives at 180° precisely when the timer hits 0
        {
          unsigned long remainingMs =
              (millis() - serviceStartTime < serviceDuration)
                  ? serviceDuration - (millis() - serviceStartTime)
                  : 1;
          // ~15ms per loop iteration; spread 180° steps across remaining
          // iterations
          int dynInterval = max(1, (int)((remainingMs / 15UL) / 180UL));
          setServoPositions(180, false);   // target: 180°
          servoStepInterval = dynInterval; // override with time-synced speed
        }
#if SSCM_DEBUG
        Serial.println("[Cleaning] Phase 4: Brushing started - CLOCKWISE, "
                       "servo sweeping to 180° over remaining time");
#endif
      }
    }

    // Phase 4: Brushing clockwise
    else if (cleaningPhase == 4) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        // Coast first to prevent back-EMF spike on direction reversal
        motorsCoast();
        cleaningPhase = 6; // transition coast
        brushNextPhase = 5;
        brushPhaseStartTime = millis();
#if SSCM_DEBUG
        Serial.println("[Cleaning] Phase 6: Coast before CCW (cycle " +
                       String(brushCurrentCycle) + ")");
#endif
      }
    }

    // Phase 5: Brushing counter-clockwise
    else if (cleaningPhase == 5) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        brushCurrentCycle++;
        if (brushCurrentCycle > BRUSH_TOTAL_CYCLES) {
          // Safety cap reached (time-based stop handled by watchdog above)
          motorsCoast();
          cleaningPhase = 0;
          brushCurrentCycle = 0;
#if SSCM_DEBUG
          Serial.println("[Cleaning] Safety cap reached (" +
                         String(BRUSH_TOTAL_CYCLES) + " cycles) - motors OFF");
#endif
          stopService();
          return;
        } else {
          // Coast first to prevent back-EMF spike on direction reversal
          motorsCoast();
          cleaningPhase = 6; // transition coast
          brushNextPhase = 4;
          brushPhaseStartTime = millis();
#if SSCM_DEBUG
          Serial.println("[Cleaning] Phase 6: Coast before CW (cycle " +
                         String(brushCurrentCycle) + ")");
#endif
        }
      }
    }

    // Phase 6: Coast transition between direction changes
    else if (cleaningPhase == 6) {
      if (millis() - brushPhaseStartTime >= BRUSH_COAST_MS) {
        cleaningPhase = brushNextPhase;
        brushPhaseStartTime = millis();
        if (brushNextPhase == 5) {
          setMotorsSameSpeed(-BRUSH_MOTOR_SPEED); // Start CCW
#if SSCM_DEBUG
          Serial.println("[Cleaning] Phase 5: Brush cycle " +
                         String(brushCurrentCycle) + " - COUNTER-CLOCKWISE");
#endif
        } else {
          setMotorsSameSpeed(BRUSH_MOTOR_SPEED); // Back to CW
#if SSCM_DEBUG
          Serial.println("[Cleaning] Phase 4: Brush cycle " +
                         String(brushCurrentCycle) + " - CLOCKWISE");
#endif
        }
      }
    }
  }

  // Sterilizing: no phase transitions — UVC + Atomizer+Fan run full duration
  // together

  // Send status updates every second
  if (millis() - lastServiceStatusUpdate >= SERVICE_STATUS_UPDATE_INTERVAL) {
    lastServiceStatusUpdate = millis();
    sendServiceStatusUpdate();
  }
}

void sendServiceStatusUpdate() {
  if (!wsConnected || !isPaired)
    return;

  unsigned long elapsed = millis() - serviceStartTime;
  unsigned long remaining = 0;

  if (elapsed < serviceDuration) {
    remaining = (serviceDuration - elapsed) / 1000; // Convert to seconds
  }

  int progress = (elapsed * 100) / serviceDuration;
  if (progress > 100)
    progress = 100;

  String msg = "{";
  msg += "\"type\":\"service-status\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"serviceType\":\"" + currentServiceType + "\",";
  msg += "\"shoeType\":\"" + currentShoeType + "\",";
  msg += "\"careType\":\"" + currentCareType + "\",";
  msg += "\"active\":" + String(serviceActive ? "true" : "false") + ",";
  msg += "\"progress\":" + String(progress) + ",";
  msg += "\"timeRemaining\":" + String(remaining);
  msg += "}";

  webSocket.sendTXT(msg);
}

/* ===================== CLASSIFICATION FUNCTIONS ===================== */
// Classification flow: Main board → ESP-NOW → CAM → ESP-NOW → Main board →
// WebSocket → Backend Offline-capable: works even if backend is down (result
// still goes to service logic)

// Handle classification result received from CAM via ESP-NOW, then relay to
// backend
void handleClassificationResultFromCAM(String shoeType, float confidence) {
#if SSCM_DEBUG
  Serial.println("\n=== CLASSIFICATION RESULT RECEIVED (ESP-NOW) ===");
  Serial.println("Shoe Type:  " + shoeType);
  Serial.println("Confidence: " + String(confidence * 100, 1) + "%");
  Serial.println("================================================\n");
#endif

  lastClassificationResult = shoeType;
  lastClassificationConfidence = confidence;

  // Relay to backend so tablet UI can display the result
  if (wsConnected && isPaired) {
    String msg = "{";
    msg += "\"type\":\"classification-result\",";
    msg += "\"deviceId\":\"" + deviceId + "\",";
    msg += "\"result\":\"" + shoeType + "\",";
    msg += "\"confidence\":" + String(confidence, 4);
    msg += "}";
    webSocket.sendTXT(msg);
    wsLog("info", "Classification result: " + shoeType + " (" +
                      String((int)(confidence * 100)) + "% confidence)");
#if SSCM_DEBUG
    Serial.println("[WebSocket] Classification result relayed to backend");
#endif
  }
}

// Relay a classification error to backend so tablet UI can show the error
void relayClassificationErrorToBackend(String errorCode) {
  if (!wsConnected || !isPaired)
    return;

  String msg = "{";
  msg += "\"type\":\"classification-error\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"error\":\"" + errorCode + "\"";
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("warn", "Classification error: " + errorCode);
#if SSCM_DEBUG
  Serial.println("[WebSocket] Classification error relayed: " + errorCode);
#endif
}

// Report CAM pairing info to backend after receiving PairingAck
void sendCamPairedToBackend() {
  if (!wsConnected)
    return;

  String msg = "{";
  msg += "\"type\":\"cam-paired\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  if (pairedCamIp.length() > 0) {
    msg += ",\"camIp\":\"" + pairedCamIp + "\"";
  }
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("info", "CAM paired: " + pairedCamDeviceId +
                    (pairedCamIp.length() > 0 ? " @ " + pairedCamIp : ""));
#if SSCM_DEBUG
  Serial.println("[WebSocket] cam-paired sent: " + pairedCamDeviceId +
                 (pairedCamIp.length() > 0 ? " @ " + pairedCamIp : ""));
#endif
}

/* ===================== DHT22 FUNCTIONS ===================== */
bool readDHT11() {
  float temp = dht.readTemperature(); // Celsius
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
#if SSCM_DEBUG
    Serial.println("[DHT11] Failed to read from sensor!");
#endif
    return false; // Reading failed
  }

  currentTemperature = temp;
  currentHumidity = hum;

#if SSCM_DEBUG
  Serial.println("[DHT11] Temp: " + String(currentTemperature, 1) +
                 "°C | Humidity: " + String(currentHumidity, 1) + "%");
#endif
  return true; // Reading successful
}

void sendDHTDataViaWebSocket() {
  // Don't send data if device is not paired
  if (!isPaired || !wsConnected)
    return;

  String sensorMsg = "{";
  sensorMsg += "\"type\":\"sensor-data\",";
  sensorMsg += "\"deviceId\":\"" + deviceId + "\",";
  sensorMsg += "\"temperature\":" + String(currentTemperature, 1) + ",";
  sensorMsg += "\"humidity\":" + String(currentHumidity, 1) + ",";
  sensorMsg += "\"camSynced\":" + String(camIsReady ? "true" : "false");
  if (pairedCamDeviceId.length() > 0) {
    sensorMsg += ",\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  }
  sensorMsg += "}";

  webSocket.sendTXT(sensorMsg);
}

// Send CAM sync status update (called when sync status changes)
void sendCamSyncStatus() {
  if (!isPaired || !wsConnected)
    return;

  // Use the new cam-paired message if we have a CAM device ID
  if (pairedCamDeviceId.length() > 0) {
    sendCamPairedToBackend();
    return;
  }

  // Fallback: send legacy cam-sync-status for backward compat
  String syncMsg = "{";
  syncMsg += "\"type\":\"cam-sync-status\",";
  syncMsg += "\"deviceId\":\"" + deviceId + "\",";
  syncMsg += "\"camSynced\":" + String(camIsReady ? "true" : "false");
  syncMsg += "}";
  webSocket.sendTXT(syncMsg);
#if SSCM_DEBUG
  Serial.println("[WebSocket] Sent CAM sync status: " +
                 String(camIsReady ? "SYNCED" : "NOT_SYNCED"));
#endif
}

/* ===================== ULTRASONIC FUNCTIONS ===================== */

// Take 5 pulseIn samples and return the median duration (µs).
// Median rejects outlier spikes and sporadic zeros from reflections/noise.
static unsigned long ultrasonicMedian(uint8_t trigPin, uint8_t echoPin) {
  unsigned long samples[5];
  for (int i = 0; i < 5; i++) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(20); // Spec requires >20µs; 25µs adds margin
    digitalWrite(trigPin, LOW);
    samples[i] = pulseIn(echoPin, HIGH, 40000);
    if (i < 4)
      delay(10); // Short gap prevents echo bleed between samples
  }
  // Insertion sort (5 elements — negligible cost)
  for (int i = 1; i < 5; i++) {
    unsigned long key = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > key) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = key;
  }
  return samples[2]; // median
}

bool readAtomizerLevel() {
  // 40ms timeout per sample; takes median of 5 samples to reject outliers
  unsigned long duration =
      ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);

  if (duration == 0) {
#if SSCM_DEBUG
    Serial.println("[Atomizer] Invalid (no echo)");
#endif
    currentAtomizerDistance = -1;
    return true;
  }

  // Datasheet formula: distance = (duration × 348 m/s) / 2
  // 348 m/s = 0.0174 cm/µs  (one-way)
  int distance = (int)(duration * 0.0174f);

  if (distance > 21) {
#if SSCM_DEBUG
    Serial.println("[Atomizer] Invalid (out of range): " + String(distance) +
                   " cm");
#endif
    currentAtomizerDistance = -1;
    return true;
  }

  currentAtomizerDistance = distance;
  return true;
}

bool readFoamLevel() {
  // 50ms gap after atomizer read — prevents cross-sensor echo interference
  delay(50);

  // 40ms timeout per sample; takes median of 5 samples to reject outliers
  unsigned long duration = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);

  if (duration == 0) {
#if SSCM_DEBUG
    Serial.println("[Foam] Invalid (no echo)");
#endif
    currentFoamDistance = -1;
    return true;
  }

  // Datasheet formula: distance = (duration × 348 m/s) / 2
  // 348 m/s = 0.0174 cm/µs  (one-way)
  int distance = (int)(duration * 0.0174f);

  if (distance > 21) {
#if SSCM_DEBUG
    Serial.println("[Foam] Invalid (out of range): " + String(distance) +
                   " cm");
#endif
    currentFoamDistance = -1;
    return true;
  }

  currentFoamDistance = distance;
  return true;
}

void sendUltrasonicDataViaWebSocket() {
  // Don't send data if device is not paired
  if (!isPaired || !wsConnected)
    return;

  String distanceMsg = "{";
  distanceMsg += "\"type\":\"distance-data\",";
  distanceMsg += "\"deviceId\":\"" + deviceId + "\",";
  distanceMsg +=
      "\"atomizerDistance\":" + String(currentAtomizerDistance) + ",";
  distanceMsg += "\"foamDistance\":" + String(currentFoamDistance);
  distanceMsg += "}";

  webSocket.sendTXT(distanceMsg);
}

/* ===================== SERVO MOTOR CONTROL (NON-BLOCKING) - DUAL SERVOS
 * ===================== */
// Non-blocking smooth servo movement - called every loop iteration
// Left servo: 0° → 180° | Right servo: 180° → 0° (mirrored)
// Speed controlled by servoStepInterval (higher = slower)
void updateServoPositions() {
  if (!servosMoving)
    return;

  unsigned long currentTime = millis();

  // Check if it's time to update servo positions (every 15ms)
  if (currentTime - lastServoUpdate >= SERVO_UPDATE_INTERVAL) {
    lastServoUpdate = currentTime;

    // Increment step counter and check if we should move
    servoStepCounter++;
    if (servoStepCounter < servoStepInterval) {
      return; // Not yet time to step
    }
    servoStepCounter = 0; // Reset counter

    bool leftReached = false;
    bool rightReached = false;

    // Update LEFT servo
    if (currentLeftPosition < targetLeftPosition) {
      currentLeftPosition++;
      servoLeft.write(currentLeftPosition);
    } else if (currentLeftPosition > targetLeftPosition) {
      currentLeftPosition--;
      servoLeft.write(currentLeftPosition);
    } else {
      leftReached = true;
    }

    // Update RIGHT servo
    if (currentRightPosition < targetRightPosition) {
      currentRightPosition++;
      servoRight.write(currentRightPosition);
    } else if (currentRightPosition > targetRightPosition) {
      currentRightPosition--;
      servoRight.write(currentRightPosition);
    } else {
      rightReached = true;
    }

    // Both servos reached target
    if (leftReached && rightReached) {
      servosMoving = false;
#if SSCM_DEBUG
      Serial.println(
          "[Servo] Reached target - Left: " + String(currentLeftPosition) +
          "° Right: " + String(currentRightPosition) + "°");
#endif
    }
  }
}

// Set servo target positions - initiates non-blocking smooth movement
// leftPos: position for left servo (0-180)
// When left goes to 180°, right goes to 0° (mirrored)
// speedMode: true = fast return, false = slow brushing movement (default)
void setServoPositions(int leftPos, bool fastMode) {
  // Constrain position to 0-180 degrees
  leftPos = constrain(leftPos, 0, 180);

  // Calculate mirrored position for right servo
  int rightPos = 180 - leftPos;

  // Set speed based on mode
  servoStepInterval =
      fastMode ? SERVO_FAST_STEP_INTERVAL : SERVO_SLOW_STEP_INTERVAL;
  servoStepCounter = 0; // Reset counter when starting new movement

  if (leftPos != currentLeftPosition || rightPos != currentRightPosition) {
    targetLeftPosition = leftPos;
    targetRightPosition = rightPos;
    servosMoving = true;
#if SSCM_DEBUG
    Serial.println("[Servo] Moving to Left: " + String(leftPos) +
                   "° Right: " + String(rightPos) + "° (" +
                   (fastMode ? "FAST" : "SLOW") + ")");
#endif
  }
}

/* ===================== DRV8871 DC MOTOR CONTROL - DUAL MOTORS
 * ===================== */
// Set LEFT motor speed and direction
void setLeftMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentLeftMotorSpeed = speed;

  if (speed > 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, speed);
    ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  } else if (speed < 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
    ledcWrite(MOTOR_LEFT_IN2_PIN, abs(speed));
  } else {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
    ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  }
}

// Set RIGHT motor speed and direction
void setRightMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentRightMotorSpeed = speed;

  if (speed > 0) {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, speed);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  } else if (speed < 0) {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, abs(speed));
  } else {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  }
}

// Set BOTH motors to same speed (tank drive straight)
void setMotorsSameSpeed(int speed) {
  setLeftMotorSpeed(speed);
  setRightMotorSpeed(speed);
}

// Stop LEFT motor with brake
void leftMotorBrake() {
  ledcWrite(MOTOR_LEFT_IN1_PIN, 255);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 255);
  currentLeftMotorSpeed = 0;
}

// Stop RIGHT motor with brake
void rightMotorBrake() {
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 255);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 255);
  currentRightMotorSpeed = 0;
}

// Stop BOTH motors with brake
void motorsBrake() {
  leftMotorBrake();
  rightMotorBrake();
}

// Stop LEFT motor with coast
void leftMotorCoast() {
  ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  currentLeftMotorSpeed = 0;
}

// Stop RIGHT motor with coast
void rightMotorCoast() {
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  currentRightMotorSpeed = 0;
}

// Stop BOTH motors with coast
void motorsCoast() {
  leftMotorCoast();
  rightMotorCoast();
}

/* ===================== TB6600 STEPPER MOTOR CONTROL ===================== */
// NOTE: Motor is ALWAYS ENABLED (ENA+ hardwired to GND)
// No enable/disable control needed - motor always has holding torque

// Calculate step interval from speed (steps per second)
void setStepper1Speed(int stepsPerSecond) {
  if (stepsPerSecond <= 0) {
    stepper1Speed = 1;
  } else if (stepsPerSecond > STEPPER1_MAX_SPEED) {
    stepper1Speed = STEPPER1_MAX_SPEED; // Max speed: 800 steps/sec = 80mm/s
                                        // (motor specification limit)
  } else {
    stepper1Speed = stepsPerSecond;
  }

  // Calculate interval in microseconds
  stepper1StepInterval = 1000000UL / stepper1Speed;
}

// Perform a single step in the specified direction - OPTIMIZED FOR SPEED
void stepper1Step(bool direction) {
  // Set direction
  digitalWrite(STEPPER1_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3); // Direction setup time (TB6600 needs 2.5us min)

  // Generate step pulse
  digitalWrite(STEPPER1_STEP_PIN, HIGH);
  delayMicroseconds(2); // Pulse width (TB6600 needs 2us min)
  digitalWrite(STEPPER1_STEP_PIN, LOW);

  // Update position
  if (direction) {
    currentStepper1Position++;
  } else {
    currentStepper1Position--;
  }
}

// Move stepper to absolute position (non-blocking - initiates movement)
void stepper1MoveTo(long position) {
  // Motor is ALWAYS ENABLED (ENA+ hardwired to GND) - ready to move!

  targetStepper1Position = position;

  if (targetStepper1Position != currentStepper1Position) {
    stepper1Moving = true;
#if SSCM_DEBUG
    Serial.println(
        "[Top Linear] Moving from " + String(currentStepper1Position) + " to " +
        String(targetStepper1Position) + " steps (" +
        String(abs(targetStepper1Position - currentStepper1Position)) +
        " steps)");
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[Top Linear] Already at target position: " +
                   String(targetStepper1Position));
#endif
  }
  // NVS write deferred to updateStepper1Position() on movement completion
}

// Move stepper relative to current position (non-blocking)
void stepper1MoveRelative(long steps) {
  targetStepper1Position = currentStepper1Position + steps;
  stepper1MoveTo(targetStepper1Position);
}

// Move stepper by millimeters (non-blocking)
void stepper1MoveByMM(float mm) {
  long steps = (long)(mm * STEPPER1_STEPS_PER_MM);
  stepper1MoveRelative(steps);
}

// Stop stepper immediately
void stepper1Stop() {
  targetStepper1Position = currentStepper1Position;
  stepper1Moving = false;
#if SSCM_DEBUG
  Serial.println("[Top Linear] Stopped at position: " +
                 String(currentStepper1Position) + " steps");
#endif
}

// Home the stepper (declare current physical location as position 0)
void stepper1Home() {
  currentStepper1Position = 0;
  targetStepper1Position = 0;
  stepper1Moving = false;
  prefs.putLong("s1pos", 0); // persist immediately so reboot keeps the zero
  wsLog("info", "S1 zeroed at current position (NVS saved)");
#if SSCM_DEBUG
  Serial.println("[Top Linear] Homed - position reset to 0");
#endif
}

// Non-blocking stepper update - called in loop()
void updateStepper1Position() {
  if (!stepper1Moving)
    return;

  unsigned long currentMicros = micros();

  // Check if enough time has passed for the next step
  if (currentMicros - lastStepper1Update >= stepper1StepInterval) {
    lastStepper1Update = currentMicros;

    if (currentStepper1Position < targetStepper1Position) {
      // Step forward
      stepper1Step(true);
    } else if (currentStepper1Position > targetStepper1Position) {
      // Step backward
      stepper1Step(false);
    } else {
      // Reached target — persist position to NVS now (not on every MoveTo call)
      stepper1Moving = false;
      prefs.putLong("s1pos", currentStepper1Position);
#if SSCM_DEBUG
      Serial.println("[Top Linear] Reached target position: " +
                     String(currentStepper1Position) + " steps");
#endif
    }
  }
}

/* ===================== TB6600 STEPPER MOTOR 2 CONTROL ===================== */
// NOTE: Motor is ALWAYS ENABLED (ENA+ hardwired to GND)
// No enable/disable control needed - motor always has holding torque

// Calculate step interval from speed (steps per second)
void setStepper2Speed(int stepsPerSecond) {
  if (stepsPerSecond <= 0) {
    stepper2Speed = 1;
  } else if (stepsPerSecond > STEPPER2_MAX_SPEED) {
    stepper2Speed = STEPPER2_MAX_SPEED; // Max speed: 24,000 steps/sec = 120mm/s
                                        // (motor specification limit)
  } else {
    stepper2Speed = stepsPerSecond;
  }

  // Calculate interval in microseconds
  stepper2StepInterval = 1000000UL / stepper2Speed;
#if SSCM_DEBUG
  Serial.println("[Side Linear] Speed: " + String(stepper2Speed) +
                 " steps/sec = " +
                 String(stepper2Speed / STEPPER2_STEPS_PER_MM) + " mm/sec");
#endif
}

// Perform a single step in the specified direction - OPTIMIZED FOR SPEED
void stepper2Step(bool direction) {
  // Set direction
  digitalWrite(STEPPER2_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3); // Direction setup time (TB6600 needs 2.5us min)

  // Generate step pulse
  digitalWrite(STEPPER2_STEP_PIN, HIGH);
  delayMicroseconds(2); // Pulse width (TB6600 needs 2us min)
  digitalWrite(STEPPER2_STEP_PIN, LOW);

  // Update position
  if (direction) {
    currentStepper2Position++;
  } else {
    currentStepper2Position--;
  }
}

// Move stepper to absolute position (non-blocking - initiates movement)
void stepper2MoveTo(long position) {
  if (position < 0)
    position = 0;
  if (position > STEPPER2_MAX_POSITION)
    position = STEPPER2_MAX_POSITION;

  // Motor is ALWAYS ENABLED (ENA+ hardwired to GND) - ready to move!

  targetStepper2Position = position;

  if (targetStepper2Position != currentStepper2Position) {
    stepper2Moving = true;
#if SSCM_DEBUG
    Serial.println(
        "[Side Linear] Moving from " + String(currentStepper2Position) +
        " to " + String(targetStepper2Position) + " steps (" +
        String(abs(targetStepper2Position - currentStepper2Position)) +
        " steps)");
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[Side Linear] Already at target position: " +
                   String(targetStepper2Position));
#endif
  }
  // NVS write deferred to updateStepper2Position() on movement completion
}

// Move stepper relative to current position (non-blocking)
void stepper2MoveRelative(long steps) {
  targetStepper2Position = currentStepper2Position + steps;
  stepper2MoveTo(targetStepper2Position);
}

// Move stepper by millimeters (non-blocking)
void stepper2MoveByMM(float mm) {
  long steps = (long)(mm * STEPPER2_STEPS_PER_MM);
  stepper2MoveRelative(steps);
}

// Stop stepper immediately
void stepper2Stop() {
  targetStepper2Position = currentStepper2Position;
  stepper2Moving = false;
#if SSCM_DEBUG
  Serial.println("[Side Linear] Stopped at position: " +
                 String(currentStepper2Position) + " steps");
#endif
}

// Home the stepper (declare current physical location as position 0)
void stepper2Home() {
  currentStepper2Position = 0;
  targetStepper2Position = 0;
  stepper2Moving = false;
  prefs.putLong("s2pos", 0); // persist immediately so reboot keeps the zero
  wsLog("info", "S2 zeroed at current position (NVS saved)");
#if SSCM_DEBUG
  Serial.println("[Side Linear] Homed - position reset to 0");
#endif
}

// Non-blocking stepper update - called in loop()
void updateStepper2Position() {
  if (!stepper2Moving)
    return;

  unsigned long currentMicros = micros();

  // Check if enough time has passed for the next step
  if (currentMicros - lastStepper2Update >= stepper2StepInterval) {
    lastStepper2Update = currentMicros;

    if (currentStepper2Position < targetStepper2Position) {
      // Step forward
      stepper2Step(true);
    } else if (currentStepper2Position > targetStepper2Position) {
      // Step backward
      stepper2Step(false);
    } else {
      // Reached target — persist position to NVS now (not on every MoveTo call)
      stepper2Moving = false;
      prefs.putLong("s2pos", currentStepper2Position);
#if SSCM_DEBUG
      Serial.println("[Side Linear] Reached target position: " +
                     String(currentStepper2Position) + " steps");
#endif
    }
  }
}

/* ===================== RGB LED STRIP CONTROL ===================== */

// Set RGB color for entire strip (0-255 for each channel)
void setRGBColor(int red, int green, int blue) {
  currentRed = constrain(red, 0, 255);
  currentGreen = constrain(green, 0, 255);
  currentBlue = constrain(blue, 0, 255);

  // Set all LEDs to the same color
  uint32_t color = strip.Color(currentRed, currentGreen, currentBlue);
  for (int i = 0; i < RGB_NUM_LEDS; i++) {
    strip.setPixelColor(i, color);
  }
  strip.show(); // Update the strip

#if SSCM_DEBUG
  Serial.println("[WS2812B] Color set - R:" + String(currentRed) +
                 " G:" + String(currentGreen) + " B:" + String(currentBlue));
#endif
}

// Preset colors
void rgbWhite() {
  setRGBColor(255, 255, 255);
#if SSCM_DEBUG
  Serial.println("[WS2812B] WHITE");
#endif
}

void rgbBlue() {
  setRGBColor(0, 0, 255);
#if SSCM_DEBUG
  Serial.println("[WS2812B] BLUE");
#endif
}

void rgbGreen() {
  setRGBColor(0, 255, 0);
#if SSCM_DEBUG
  Serial.println("[WS2812B] GREEN");
#endif
}

void rgbViolet() {
  setRGBColor(238, 130, 238); // Violet color
#if SSCM_DEBUG
  Serial.println("[WS2812B] VIOLET");
#endif
}

void rgbPink() {
  setRGBColor(255, 20, 147); // Deep pink
#if SSCM_DEBUG
  Serial.println("[WS2812B] PINK");
#endif
}

void rgbOff() {
  setRGBColor(0, 0, 0);
#if SSCM_DEBUG
  Serial.println("[WS2812B] OFF (all LEDs off)");
#endif
}

/* ===================== COIN SLOT INTERRUPT HANDLER ===================== */
void IRAM_ATTR handleCoinPulse() {
  // Only accept pulses when payment is enabled (on payment page)
  if (!paymentEnabled) {
    return;
  }

  // Filter EMI glitches: confirm pin is actually LOW before counting
  if (digitalRead(COIN_SLOT_PIN) != LOW) {
    return;
  }

  unsigned long currentTime = millis();
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  portEXIT_CRITICAL_ISR(&paymentMux);
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) {
    return;
  }

  // Debounce: ignore if less than COIN_PULSE_DEBOUNCE_TIME has passed
  if (currentTime - lastCoinPulseTime > COIN_PULSE_DEBOUNCE_TIME) {
    lastCoinPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentCoinPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}

/* ===================== BILL ACCEPTOR INTERRUPT HANDLER =====================
 */
void IRAM_ATTR handleBillPulse() {
  // Only accept pulses when payment is enabled (on payment page)
  if (!paymentEnabled) {
    return;
  }

  // Filter EMI glitches: confirm pin is actually LOW before counting
  if (digitalRead(BILL_PULSE_PIN) != LOW) {
    return;
  }

  unsigned long currentTime = millis();
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  portEXIT_CRITICAL_ISR(&paymentMux);
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) {
    return;
  }

  // Debounce: ignore if less than BILL_PULSE_DEBOUNCE_TIME has passed
  if (currentTime - lastBillPulseTime > BILL_PULSE_DEBOUNCE_TIME) {
    lastBillPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentBillPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}

/* ===================== FACTORY RESET ===================== */
void factoryReset() {
  allRelaysOff();
  // Log current totals before wiping — provides an audit trail in the kiosk
  // browser console
  wsLog("warn", "Factory reset triggered — final totals: Coin ₱" +
                    String(totalCoinPesos) + ", Bill ₱" +
                    String(totalBillPesos) + ", Total ₱" + String(totalPesos));
  // If ESP-NOW is up and CAM is paired, reset CAM first before clearing our own
  // prefs
  if (espNowInitialized && camMacPaired) {
#if SSCM_DEBUG
    Serial.println("[FactoryReset] Sending reset command to CAM...");
#endif
    CamMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.type = CAM_MSG_FACTORY_RESET;
    // Send 3 times to improve delivery reliability (ESP-NOW is fire-and-forget)
    for (int i = 0; i < 3; i++) {
      esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
      delay(500);
    }
#if SSCM_DEBUG
    Serial.println("[FactoryReset] Waiting for CAM to process reset...");
#endif
    delay(1000);
  } else {
#if SSCM_DEBUG
    Serial.println("[FactoryReset] CAM not reachable (ESP-NOW not ready) — "
                   "skipping CAM reset");
#endif
  }

#if SSCM_DEBUG
  Serial.println("[FactoryReset] Clearing main board preferences...");
#endif
  prefs.clear();
#if SSCM_DEBUG
  Serial.println("[FactoryReset] Done. Restarting...");
#endif
  delay(500);
  ESP.restart();
}

/* ===================== OTA UPDATE ===================== */
void setupOTA() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char hostname[24];
  snprintf(hostname, sizeof(hostname), "sscm-main-%02X%02X", mac[4], mac[5]);
  ArduinoOTA.setHostname(hostname);
  if (groupToken.length() == 8) {
    ArduinoOTA.setPassword(groupToken.c_str());
  } else {
    ArduinoOTA.setPassword("SSCM-OTA");
  }
  ArduinoOTA.onStart([]() {
#if SSCM_DEBUG
    Serial.println("[OTA] Starting update...");
#endif
    allRelaysOff(); // Safety: turn off outputs before flashing
    wsLog("warn", "OTA firmware update started — device will restart");
  });
  ArduinoOTA.onEnd([]() {
#if SSCM_DEBUG
    Serial.println("[OTA] Done.");
#endif
    wsLog("info", "OTA update complete — restarting now");
  });
  ArduinoOTA.onError([](ota_error_t error) {
#if SSCM_DEBUG
    Serial.printf("[OTA] Error [%u]\n", error);
#endif
    wsLog("error", "OTA update failed — error code: " + String(error));
  });
  ArduinoOTA.begin();
#if SSCM_DEBUG
  Serial.println("[OTA] Ready. Hostname: " + String(hostname));
#endif
}

/* ===================== SETUP ===================== */
void setup() {
  Serial.begin(115200);

#if SSCM_DEBUG
  Serial.println("\n\n=================================");
  Serial.printf("  %s\n", BOARD_NAME);
  Serial.printf("  Firmware v%s\n", FIRMWARE_VERSION);
  Serial.println("=================================\n");
#endif

  prefs.begin("sscm", false);

  currentStepper1Position = prefs.getLong("s1pos", 0);
  currentStepper2Position = prefs.getLong("s2pos", 0);
#if SSCM_DEBUG
  Serial.println("[Setup] Stepper1 pos restored: " +
                 String(currentStepper1Position));
  Serial.println("[Setup] Stepper2 pos restored: " +
                 String(currentStepper2Position));
#endif

  // Factory reset via BOOT button (GPIO0) held at power-on for 3s
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
#if SSCM_DEBUG
    Serial.println(
        "[Setup] BOOT button held — hold 3s to confirm factory reset...");
#endif
    delay(3000);
    if (digitalRead(0) == LOW) {
#if SSCM_DEBUG
      Serial.println("[Setup] Confirmed — triggering factory reset!");
#endif
      factoryReset();
    }
#if SSCM_DEBUG
    Serial.println("[Setup] BOOT button released — factory reset cancelled");
#endif
  }

  // Initialize ESP-NOW for wireless communication with ESP32-CAM
  // Note: ESP-NOW will be fully initialized after WiFi mode is set

  // Initialize DHT22 sensor
  dht.begin();

  // Initialize JSN-SR20-Y1 ultrasonic sensors
  pinMode(ATOMIZER_TRIG_PIN, OUTPUT);
  pinMode(ATOMIZER_ECHO_PIN, INPUT);
  digitalWrite(ATOMIZER_TRIG_PIN, LOW);

  pinMode(FOAM_TRIG_PIN, OUTPUT);
  pinMode(FOAM_ECHO_PIN, INPUT);
  digitalWrite(FOAM_TRIG_PIN, LOW);

  // Initialize servo motors (Tower Pro MG995) - Dual servos
  servoLeft.attach(SERVO_LEFT_PIN);
  servoRight.attach(SERVO_RIGHT_PIN);

  servoLeft.write(0);    // Left starts at 0 degrees
  servoRight.write(180); // Right starts at 180 degrees (mirrored)

  currentLeftPosition = 0;
  currentRightPosition = 180;

#if SSCM_DEBUG
  Serial.println("[Servo] Left attached:" + String(servoLeft.attached()) +
                 " pin:" + String(SERVO_LEFT_PIN));
  Serial.println("[Servo] Right attached:" + String(servoRight.attached()) +
                 " pin:" + String(SERVO_RIGHT_PIN));
#endif
  targetLeftPosition = 0;
  targetRightPosition = 180;

  // Initialize DRV8871 DC Motor Drivers (Dual Motors) with PWM
  // IMPORTANT: Set pins LOW before attaching PWM to prevent motor spin at boot
  pinMode(MOTOR_LEFT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_LEFT_IN2_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2_PIN, OUTPUT);
  digitalWrite(MOTOR_LEFT_IN1_PIN, LOW);
  digitalWrite(MOTOR_LEFT_IN2_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN1_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN2_PIN, LOW);

  // Now attach PWM and immediately set duty to 0
  ledcAttach(MOTOR_LEFT_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
  ledcAttach(MOTOR_LEFT_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  ledcAttach(MOTOR_RIGHT_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
  ledcAttach(MOTOR_RIGHT_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);

  motorsCoast();

  // Initialize TB6600 Stepper Motor Driver (NEMA11 Linear Stepper)
  pinMode(STEPPER1_STEP_PIN, OUTPUT);
  pinMode(STEPPER1_DIR_PIN, OUTPUT);
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  digitalWrite(STEPPER1_DIR_PIN, LOW);
  // ENA+ hardwired to GND - motor ALWAYS ENABLED (no pin control needed)

  // Set initial speed
  setStepper1Speed(800); // 800 steps/second default
#if SSCM_DEBUG
  Serial.println("[Stepper1] Top linear: GPIO " + String(STEPPER1_STEP_PIN) +
                 "/" + String(STEPPER1_DIR_PIN) + ", " +
                 String(stepper1Speed / STEPPER1_STEPS_PER_MM) + "mm/s");
#endif

  // Initialize Side Linear Stepper (Double)
  pinMode(STEPPER2_STEP_PIN, OUTPUT);
  pinMode(STEPPER2_DIR_PIN, OUTPUT);
  digitalWrite(STEPPER2_STEP_PIN, LOW);
  digitalWrite(STEPPER2_DIR_PIN, LOW);
  // ENA+ hardwired to GND - motor ALWAYS ENABLED (no pin control needed)

  // Set initial speed
  setStepper2Speed(1500); // 1500 steps/second default (7.5mm/s)
#if SSCM_DEBUG
  Serial.println("[Stepper2] Side linear: GPIO " + String(STEPPER2_STEP_PIN) +
                 "/" + String(STEPPER2_DIR_PIN) + ", " +
                 String(stepper2Speed / STEPPER2_STEPS_PER_MM) + "mm/s");
#endif

  // Auto-return to 0 on boot so the machine is always ready for cleaning
  if (currentStepper1Position != 0) {
    Serial.println("[Setup] S1 not at 0 (" + String(currentStepper1Position) +
                   "), returning to home");
    stepper1MoveTo(0);
  }
  if (currentStepper2Position != 0) {
    Serial.println("[Setup] S2 not at 0 (" + String(currentStepper2Position) +
                   "), returning to home");
    stepper2MoveTo(0);
  }

  // Initialize WS2812B LED Strip (NeoPixel)
  strip.begin(); // Initialize NeoPixel strip object
  strip.setBrightness(
      100);     // Set moderate brightness to reduce power draw (0-255)
  strip.show(); // Initialize all pixels to 'off'

#if SSCM_DEBUG
  Serial.println("[RGB] " + String(RGB_NUM_LEDS) + " LEDs on GPIO " +
                 String(RGB_DATA_PIN));
#endif

  // Initialize 8-channel relay
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  pinMode(RELAY_3_PIN, OUTPUT);
  pinMode(RELAY_4_PIN, OUTPUT);
  pinMode(RELAY_5_PIN, OUTPUT);
  pinMode(RELAY_6_PIN, OUTPUT);
  pinMode(RELAY_7_PIN, OUTPUT);
  pinMode(RELAY_8_PIN, OUTPUT);

  // Turn all relays OFF initially
  allRelaysOff();
#if SSCM_DEBUG
  Serial.println("[Relay] 8-channel initialized, all OFF");
#endif

  // Initialize coin acceptor
  pinMode(COIN_SLOT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_SLOT_PIN), handleCoinPulse,
                  FALLING);

  // Initialize bill acceptor
  pinMode(BILL_PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BILL_PULSE_PIN), handleBillPulse,
                  FALLING);

  // Load totals from preferences
  totalCoinPesos = prefs.getUInt("totalCoinPesos", 0);
  totalBillPesos = prefs.getUInt("totalBillPesos", 0);
  totalPesos = totalCoinPesos + totalBillPesos;

  // Initialize device ID (persistent, derived from chip MAC)
  deviceId = prefs.getString("deviceId", "");
  if (deviceId.length() == 0) {
    deviceId = generateDeviceId();
    prefs.putString("deviceId", deviceId);
  }

  // Initialize groupToken (persistent, generated once on first boot)
  groupToken = prefs.getString("groupToken", "");
  if (groupToken.length() == 0) {
    groupToken = generateGroupToken();
    prefs.putString("groupToken", groupToken);
#if SSCM_DEBUG
    Serial.println("[Setup] Generated new groupToken: " + groupToken);
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[Setup] Loaded groupToken: " + groupToken);
#endif
  }

  // Check if device is paired
  isPaired = prefs.getBool("paired", false);

  // Generate pairing code if not paired
  if (!isPaired) {
    pairingCode = generatePairingCode();
  }

#if SSCM_DEBUG
  Serial.println("\n--- Device Info ---");
  Serial.println("ID:         " + deviceId);
  Serial.println("GroupToken: " + groupToken);
  Serial.println("Paired:     " +
                 String(isPaired ? "Yes" : "No - Code: " + pairingCode));
  Serial.println("Money:      " + String(totalPesos) + " PHP");
  Serial.println("-------------------\n");
#endif

  // Check if we have WiFi credentials
  String storedSSID = prefs.getString("ssid", "");

  if (storedSSID.length() == 0) {
    // No credentials — start SoftAP captive portal only
#if SSCM_DEBUG
    Serial.println("[Setup] No WiFi credentials - starting SoftAP");
#endif
    startSoftAP();
  } else {
    // Has credentials — init ESP-NOW then connect WiFi
#if SSCM_DEBUG
    Serial.println("[Setup] WiFi credentials found - connecting");
#endif
    WiFi.mode(WIFI_STA);
    delay(100);
    initESPNow(); // Init only — pairing broadcast deferred until WiFi connects
    delay(100);
    connectWiFi();
  }
}

/* =================== SERIAL COMMAND HANDLER =================== */

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0)
    return;

  if (cmd == "RESET_WIFI") {
    prefs.remove("ssid");
    prefs.remove("pass");
#if SSCM_DEBUG
    Serial.println("WiFi reset, restarting...");
#endif
    delay(1000);
    ESP.restart();
  } else if (cmd == "RESET_PAIRING") {
    prefs.putBool("paired", false);
    isPaired = false;
    pairingCode = generatePairingCode();
#if SSCM_DEBUG
    Serial.println("Pairing reset, code: " + pairingCode);
#endif
    delay(1000);
    ESP.restart();
  } else if (cmd == "RESET_MONEY") {
    totalCoinPesos = 0;
    totalBillPesos = 0;
    totalPesos = 0;
    currentCoinPulses = 0;
    currentBillPulses = 0;
    prefs.putUInt("totalCoinPesos", 0);
    prefs.putUInt("totalBillPesos", 0);
#if SSCM_DEBUG
    Serial.println("Money counters reset");
#endif
  } else if (cmd == "FACTORY_RESET") {
#if SSCM_DEBUG
    Serial.println("[Serial] Factory reset command received!");
#endif
    factoryReset();
  } else if (cmd == "STATUS") {
    wsLog("info", "Device: " + deviceId);
    wsLog("info", "WiFi: " + String(wifiConnected ? WiFi.localIP().toString()
                                                  : "Disconnected"));
    wsLog("info", "WS: " + String(wsConnected ? "OK" : "Down"));
    wsLog("info", "Paired: " + String(isPaired ? "Yes" : pairingCode));
    wsLog("info", "Money: " + String(totalPesos) + " PHP");
    wsLog("info", "Temp: " + String(currentTemperature) +
                      "C, Humidity: " + String(currentHumidity) + "%");
    wsLog("info", "Stepper1: " + String(currentStepper1Position / 10.0) + "mm" +
                      (stepper1Moving ? " (moving)" : ""));
    wsLog("info", "Stepper2: " + String(currentStepper2Position / 200.0) +
                      "mm" + (stepper2Moving ? " (moving)" : ""));
#if SSCM_DEBUG
    Serial.println("\nDevice: " + deviceId);
    Serial.println("WiFi: " + String(wifiConnected ? WiFi.localIP().toString()
                                                   : "Disconnected"));
    Serial.println("WS: " + String(wsConnected ? "OK" : "Down"));
    Serial.println("Paired: " + String(isPaired ? "Yes" : pairingCode));
    Serial.println("Money: " + String(totalPesos) + " PHP");
    Serial.println("Temp: " + String(currentTemperature) +
                   "°C, Humidity: " + String(currentHumidity) + "%");
    Serial.println("Stepper1: " + String(currentStepper1Position / 10.0) +
                   "mm" + (stepper1Moving ? " (moving)" : ""));
    Serial.println("Stepper2: " + String(currentStepper2Position / 200.0) +
                   "mm" + (stepper2Moving ? " (moving)" : ""));
#endif
  } else if (cmd.startsWith("RELAY")) {
    // Commands: RELAY_1_ON, RELAY_1_OFF, RELAY_ALL_OFF
    if (cmd == "RELAY_ALL_OFF") {
      allRelaysOff();
    } else {
      // Parse RELAY_X_ON or RELAY_X_OFF
      int firstUnderscore = cmd.indexOf('_');
      int secondUnderscore = cmd.indexOf('_', firstUnderscore + 1);

      if (firstUnderscore != -1 && secondUnderscore != -1) {
        String channelStr =
            cmd.substring(firstUnderscore + 1, secondUnderscore);
        String action = cmd.substring(secondUnderscore + 1);

        int channel = channelStr.toInt();
        if (channel >= 1 && channel <= 8) {
          if (action == "ON") {
            setRelay(channel, true);
          } else if (action == "OFF") {
            setRelay(channel, false);
          } else {
#if SSCM_DEBUG
            Serial.println("[ERROR] Use: RELAY_X_ON/OFF or RELAY_ALL_OFF");
#endif
          }
        } else {
#if SSCM_DEBUG
          Serial.println("[ERROR] Invalid channel (1-8)");
#endif
        }
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Use: RELAY_X_ON/OFF or RELAY_ALL_OFF");
#endif
      }
    }
  } else if (cmd == "SERVO_DEMO") {
    // Blocking demo that still drives the non-blocking update loop
    const int demoAngles[] = {0, 90, 180, 0};
    for (int i = 0; i < 4; i++) {
      setServoPositions(demoAngles[i], true);
      unsigned long t = millis();
      while (servosMoving && millis() - t < 3000) {
        updateServoPositions();
        delay(1);
      }
    }
#if SSCM_DEBUG
    Serial.println("Servo demo complete (0°→90°→180°→0°)");
#endif
  } else if (cmd == "SERVO_STATUS") {
    Serial.println("[Servo] Left: " + String(currentLeftPosition) +
                   "° Right: " + String(currentRightPosition) +
                   "° | Moving: " + String(servosMoving) +
                   " | Target L: " + String(targetLeftPosition) +
                   "° R: " + String(targetRightPosition) + "°");
    Serial.println("[Servo] Attached L:" + String(servoLeft.attached()) +
                   " R:" + String(servoRight.attached()));
  } else if (cmd.startsWith("SERVO_DIRECT_")) {
    // Bypass non-blocking system — write directly to servo hardware
    String angleStr = cmd.substring(13);
    int angle = constrain(angleStr.toInt(), 0, 180);
    servoLeft.write(angle);
    servoRight.write(180 - angle);
    currentLeftPosition = angle;
    currentRightPosition = 180 - angle;
    targetLeftPosition = angle;
    targetRightPosition = 180 - angle;
    servosMoving = false;
    Serial.println("[Servo] DIRECT write L:" + String(angle) +
                   "° R:" + String(180 - angle) + "°");
  } else if (cmd.startsWith("SERVO_")) {
    // Parse SERVO_XXX where XXX is angle for LEFT servo (0-180)
    // Right servo will mirror automatically
    String angleStr = cmd.substring(6);
    int angle = angleStr.toInt();

    if (angle >= 0 && angle <= 180) {
      setServoPositions(angle, true); // fast mode for manual commands
    } else {
#if SSCM_DEBUG
      Serial.println("[ERROR] Angle 0-180 (use: SERVO_X)");
#endif
    }
  } else if (cmd.startsWith("MOTOR_LEFT_")) {
    // Left motor commands
    String subCmd = cmd.substring(11); // Remove "MOTOR_LEFT_"

    if (subCmd == "BRAKE") {
      leftMotorBrake();
    } else if (subCmd == "COAST" || subCmd == "STOP") {
      leftMotorCoast();
    } else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) {
        setLeftMotorSpeed(speed);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Invalid speed: " + subCmd);
#endif
      }
    }
  } else if (cmd.startsWith("MOTOR_RIGHT_")) {
    // Right motor commands
    String subCmd = cmd.substring(12); // Remove "MOTOR_RIGHT_"

    if (subCmd == "BRAKE") {
      rightMotorBrake();
    } else if (subCmd == "COAST" || subCmd == "STOP") {
      rightMotorCoast();
    } else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) {
        setRightMotorSpeed(speed);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Invalid speed: " + subCmd);
#endif
      }
    }
  } else if (cmd.startsWith("MOTOR_")) {
    // Both motors same speed commands
    String subCmd = cmd.substring(6); // Remove "MOTOR_"

    if (subCmd == "BRAKE") {
      motorsBrake();
    } else if (subCmd == "COAST" || subCmd == "STOP") {
      motorsCoast();
    } else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) {
        setMotorsSameSpeed(speed);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Speed -255 to 255 (use: MOTOR_X)");
#endif
      }
    }
  } else if (cmd.startsWith("STEPPER1_")) {
    // Stepper motor 1 commands
    String subCmd = cmd.substring(9); // Remove "STEPPER1_"

    if (subCmd == "ENABLE" || subCmd == "DISABLE") {
#if SSCM_DEBUG
      Serial.println("[Stepper1] Always enabled (ENA+ hardwired)");
#endif
    } else if (subCmd == "TEST_MANUAL") {
#if SSCM_DEBUG
      Serial.println("[Stepper1] Testing 10 steps...");
#endif
      for (int i = 0; i < 10; i++) {
        digitalWrite(STEPPER1_DIR_PIN, HIGH);
        delayMicroseconds(5);
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
        delayMicroseconds(20);
        digitalWrite(STEPPER1_STEP_PIN, LOW);
        delayMicroseconds(20);
      }
#if SSCM_DEBUG
      Serial.println("[Stepper1] Test done");
#endif
    } else if (subCmd == "TEST_PINS") {
      // Test if pins are actually outputting
#if SSCM_DEBUG
      Serial.println(
          "[Top Linear] Pin Output Test (rapid pulses - non-blocking)");
      Serial.println("[Top Linear] Blinking STEP pin (GPIO " +
                     String(STEPPER1_STEP_PIN) + ") 10 times");
      Serial.println(
          "[Top Linear] Measure with oscilloscope or logic analyzer");
#endif

      for (int i = 0; i < 10; i++) {
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
#if SSCM_DEBUG
        Serial.println("[Top Linear] STEP pin HIGH (3.3V)");
#endif
        delayMicroseconds(100); // 100us pulse - visible on scope
        digitalWrite(STEPPER1_STEP_PIN, LOW);
#if SSCM_DEBUG
        Serial.println("[Top Linear] STEP pin LOW (0V)");
#endif
        delayMicroseconds(100); // 100us gap
      }

#if SSCM_DEBUG
      Serial.println("[Top Linear] Pin test complete (10 rapid pulses sent)");
      Serial.println("[Top Linear] Use oscilloscope to verify - too fast for "
                     "multimeter");
#endif
    } else if (subCmd == "TEST_PULSE") {
      // Rapid pulse test - SHORT non-blocking version
#if SSCM_DEBUG
      Serial.println("[Top Linear] RAPID PULSE TEST (non-blocking)");
      Serial.println(
          "[Top Linear] Sending 100 rapid pulses at 1000 pulses/sec");
      Serial.println("[Top Linear] TB6600 should click/buzz!");
#endif

      // Send 100 pulses rapidly (~100ms total - non-blocking)
      int pulseCount = 100;
      for (int i = 0; i < pulseCount; i++) {
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
        delayMicroseconds(20);
        digitalWrite(STEPPER1_STEP_PIN, LOW);
        delayMicroseconds(980); // ~1000 pulses/sec
      }

#if SSCM_DEBUG
      Serial.println("[Top Linear] Sent " + String(pulseCount) +
                     " pulses in ~100ms");
      Serial.println(
          "[Top Linear] Did TB6600 make buzzing noise? Did motor vibrate?");
#endif
    } else if (subCmd == "STOP") {
      stepper1Stop();
    } else if (subCmd == "HOME") {
      // Declare current physical position as zero (no movement)
      stepper1Home();
    } else if (subCmd == "RETURN") {
      // Physically move back to position 0
      wsLog("info", "S1 returning to zero (pos=" +
                        String(currentStepper1Position) + ")");
      stepper1MoveTo(0);
    } else if (subCmd == "INFO") {
      wsLog("info", "S1 pos=" + String(currentStepper1Position) +
                        " spd=" + String(stepper1Speed) +
                        (stepper1Moving ? " MOVING" : " IDLE"));
#if SSCM_DEBUG
      Serial.println("Pos: " + String(currentStepper1Position / 10.0) +
                     "mm, Speed: " + String(stepper1Speed / 10) +
                     "mm/s, Moving: " + String(stepper1Moving));
#endif
    } else if (subCmd.startsWith("SPEED_")) {
      // STEPPER1_SPEED_XXX - set speed in steps per second
      String speedStr = subCmd.substring(6);
      int speed = speedStr.toInt();
      if (speed > 0 && speed <= 800) {
        setStepper1Speed(speed);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Invalid stepper speed: " + speedStr);
        Serial.println("Valid range: 1-800 steps/second (motor max: 80mm/s)");
#endif
      }
    } else if (subCmd.startsWith("MOVE_")) {
      // STEPPER1_MOVE_XXX - move relative steps
      String stepsStr = subCmd.substring(5);
      long steps = stepsStr.toInt();
      stepper1MoveRelative(steps);
    } else if (subCmd.startsWith("GOTO_")) {
      // STEPPER1_GOTO_XXX - move to absolute position
      String posStr = subCmd.substring(5);
      long position = posStr.toInt();
      stepper1MoveTo(position);
    } else if (subCmd.startsWith("MM_")) {
      // STEPPER1_MM_XXX - move by millimeters (can be negative)
      String mmStr = subCmd.substring(3);
      float mm = mmStr.toFloat();
      stepper1MoveByMM(mm);
    } else {
#if SSCM_DEBUG
      Serial.println("[ERROR] Unknown stepper1 command");
#endif
    }
  } else if (cmd.startsWith("STEPPER2_")) {
    // Stepper motor 2 commands
    String subCmd = cmd.substring(9); // Remove "STEPPER2_"

    if (subCmd == "ENABLE" || subCmd == "DISABLE") {
#if SSCM_DEBUG
      Serial.println("[Stepper2] Always enabled (ENA+ hardwired)");
#endif
    } else if (subCmd == "STOP") {
      stepper2Stop();
    } else if (subCmd == "HOME") {
      // Declare current physical position as zero (no movement)
      stepper2Home();
    } else if (subCmd == "RETURN") {
      // Physically move back to position 0
      wsLog("info", "S2 returning to zero (pos=" +
                        String(currentStepper2Position) + ")");
      stepper2MoveTo(0);
    } else if (subCmd == "INFO") {
      wsLog("info", "S2 pos=" + String(currentStepper2Position) +
                        " spd=" + String(stepper2Speed) +
                        (stepper2Moving ? " MOVING" : " IDLE"));
    } else if (subCmd.startsWith("SPEED_")) {
      // STEPPER2_SPEED_XXX - set speed in steps per second
      String speedStr = subCmd.substring(6);
      int speed = speedStr.toInt();
      if (speed > 0 && speed <= STEPPER2_MAX_SPEED) {
        setStepper2Speed(speed);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Invalid stepper2 speed: " + speedStr);
        Serial.println("Valid range: 1-" + String(STEPPER2_MAX_SPEED) +
                       " steps/second (motor max: 120mm/s)");
#endif
      }
    } else if (subCmd.startsWith("MOVE_")) {
      // STEPPER2_MOVE_XXX - move relative steps (can be negative)
      String stepsStr = subCmd.substring(5);
      long steps = stepsStr.toInt();
      stepper2MoveRelative(steps);
    } else if (subCmd.startsWith("GOTO_")) {
      // STEPPER2_GOTO_XXX - move to absolute position
      String posStr = subCmd.substring(5);
      long position = posStr.toInt();
      stepper2MoveTo(position);
    } else if (subCmd.startsWith("MM_")) {
      // STEPPER2_MM_XXX - move by millimeters (can be negative)
      String mmStr = subCmd.substring(3);
      float mm = mmStr.toFloat();
      stepper2MoveByMM(mm);
    } else {
#if SSCM_DEBUG
      Serial.println("[ERROR] Unknown stepper2 command");
#endif
    }
  } else if (cmd.startsWith("RGB_")) {
    // RGB LED Strip commands
    String subCmd = cmd.substring(4); // Remove "RGB_"

    if (subCmd == "WHITE") {
      rgbWhite();
    } else if (subCmd == "BLUE") {
      rgbBlue();
    } else if (subCmd == "GREEN") {
      rgbGreen();
    } else if (subCmd == "VIOLET") {
      rgbViolet();
    } else if (subCmd == "OFF") {
      rgbOff();
    } else if (subCmd.startsWith("CUSTOM_")) {
      // RGB_CUSTOM_R_G_B - set custom color (e.g., RGB_CUSTOM_255_128_64)
      String rgbStr = subCmd.substring(7); // Remove "CUSTOM_"

      // Parse R_G_B values
      int firstUnderscore = rgbStr.indexOf('_');
      int secondUnderscore = rgbStr.indexOf('_', firstUnderscore + 1);

      if (firstUnderscore > 0 && secondUnderscore > firstUnderscore) {
        int red = rgbStr.substring(0, firstUnderscore).toInt();
        int green =
            rgbStr.substring(firstUnderscore + 1, secondUnderscore).toInt();
        int blue = rgbStr.substring(secondUnderscore + 1).toInt();
        setRGBColor(red, green, blue);
      } else {
#if SSCM_DEBUG
        Serial.println("[ERROR] Use: RGB_CUSTOM_R_G_B");
#endif
      }
    } else {
#if SSCM_DEBUG
      Serial.println("[ERROR] Unknown RGB command");
#endif
    }
  } else if (cmd.startsWith("CAM_")) {
    // ESP32-CAM commands (via WebSocket)
    String subCmd = cmd.substring(4);

    if (subCmd == "BROADCAST") {
#if SSCM_DEBUG
      Serial.println("[CAM] Broadcasting pairing via ESP-NOW...");
#endif
      sendPairingBroadcast();
    } else if (subCmd == "CLASSIFY") {
#if SSCM_DEBUG
      Serial.println("[CAM] Requesting classification via ESP-NOW...");
#endif
      sendClassifyRequest();
    } else {
#if SSCM_DEBUG
      Serial.println("[ERROR] Unknown CAM command");
#endif
    }
  }
}

/* ===================== LOOP ===================== */
bool otaInitialized = false; // Set to true once setupOTA() has been called

void loop() {
  if (otaInitialized)
    ArduinoOTA.handle();

  // Handle WebSocket - MUST call loop() even when not connected for handshake
  webSocket.loop();

  // Dispatch deferred ESP-NOW results (enqueued from onDataRecv, dispatched
  // here on core 1)
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
        handleClassificationResultFromCAM(String(entry.shoeType),
                                          entry.confidence);
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

  // Note: ESP32-CAM communication is now via WebSocket (no serial)

  // Update servo positions for smooth non-blocking movement (dual servos)
  updateServoPositions();

  // Update stepper motor position for non-blocking movement
  updateStepper1Position();
  updateStepper2Position();

  // Handle coin insertion with pulse counting and timeout.
  // Guard on paymentEnabled: acceptors send initialization pulses on power-up
  // (e.g. when relay 1 is turned on for testing). Without this guard, those
  // pulses would be counted as real coin insertions.
  if (paymentEnabled && currentCoinPulses > 0) {
    unsigned long timeSinceLastPulse = millis() - lastCoinPulseTime;

    // Check if coin insertion is complete (no new pulse for
    // COIN_COMPLETE_TIMEOUT ms)
    if (timeSinceLastPulse >= COIN_COMPLETE_TIMEOUT) {
      // Atomically snapshot and clear to avoid losing ISR pulses mid-read
      portENTER_CRITICAL(&paymentMux);
      unsigned int coinValue = currentCoinPulses;
      currentCoinPulses = 0;
      portEXIT_CRITICAL(&paymentMux);

      totalCoinPesos += coinValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty =
          true; // Flush to NVS in periodic save (avoids blocking flash write)

#if SSCM_DEBUG
      Serial.println("[COIN] " + String(coinValue) +
                     " PHP (Total: " + String(totalPesos) + " PHP)");
#endif

      if (isPaired && wsConnected) {
        String coinMsg = "{\"type\":\"coin-inserted\",\"deviceId\":\"" +
                         deviceId + "\",\"coinValue\":" + String(coinValue) +
                         ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(coinMsg);
        wsLog("info", "Coin inserted: ₱" + String(coinValue) + " | Total: ₱" +
                          String(totalPesos));
      }
    }
  }

  // Handle bill insertion — same paymentEnabled guard as coin handling above
  if (paymentEnabled && currentBillPulses > 0) {
    unsigned long timeSinceLastPulse = millis() - lastBillPulseTime;

    // Check if bill insertion is complete (no new pulse for
    // BILL_COMPLETE_TIMEOUT ms)
    if (timeSinceLastPulse >= BILL_COMPLETE_TIMEOUT) {
      // Atomically snapshot and clear to avoid losing ISR pulses mid-read
      portENTER_CRITICAL(&paymentMux);
      unsigned int billPulses = currentBillPulses;
      currentBillPulses = 0;
      portEXIT_CRITICAL(&paymentMux);

      // 1 pulse = 10 pesos
      unsigned int billValue = billPulses * 10;

      totalBillPesos += billValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty =
          true; // Flush to NVS in periodic save (avoids blocking flash write)

#if SSCM_DEBUG
      Serial.println("[BILL] " + String(billValue) +
                     " PHP (Total: " + String(totalPesos) + " PHP)");
#endif

      if (isPaired && wsConnected) {
        String billMsg = "{\"type\":\"bill-inserted\",\"deviceId\":\"" +
                         deviceId + "\",\"billValue\":" + String(billValue) +
                         ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(billMsg);
        wsLog("info", "Bill inserted: ₱" + String(billValue) + " | Total: ₱" +
                          String(totalPesos));
      }
    }
  }

  // Periodic NVS flush for coin/bill totals — avoids blocking flash write on
  // every insertion
  if (totalsDirty && (millis() - lastTotalsSave >= TOTALS_SAVE_INTERVAL)) {
    prefs.putUInt("totalCoinPesos", totalCoinPesos);
    prefs.putUInt("totalBillPesos", totalBillPesos);
    lastTotalsSave = millis();
    totalsDirty = false;
  }

  // Keep-alive: ping the CAM every 30s so it replies and refreshes
  // lastCamHeartbeat
  if (camIsReady && camMacPaired &&
      (millis() - lastCamPing >= CAM_PING_INTERVAL)) {
    lastCamPing = millis();
    CamMessage ping;
    memset(&ping, 0, sizeof(ping));
    ping.type = CAM_MSG_STATUS_PING;
    esp_now_send(camMacAddress, (uint8_t *)&ping, sizeof(ping));
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] STATUS_PING sent to CAM");
#endif
  }

  if (camIsReady && (millis() - lastCamHeartbeat > CAM_HEARTBEAT_TIMEOUT)) {
#if SSCM_DEBUG
    Serial.println("[Pairing] CAM heartbeat lost — clearing camIsReady");
#endif
    camIsReady = false;
    lastCamHeartbeat = millis();
  }

  // Retry pairing broadcast until CAM sends PairingAck (handles simultaneous
  // boot)
  if (!camIsReady && pairingBroadcastStarted) {
    if (millis() - lastPairingBroadcastTime >= PAIRING_BROADCAST_INTERVAL) {
      static uint32_t broadcastRetryCount = 0;
      broadcastRetryCount++;
      if (broadcastRetryCount % 6 == 1) { // Log every 30 seconds
#if SSCM_DEBUG
        Serial.printf("[ESP-NOW] Retrying pairing broadcast (attempt %lu)...\n",
                      broadcastRetryCount);
#endif
      }
      sendPairingBroadcast();
    }
  }

  // Handle classification timeout (CAM didn't respond within
  // CAM_CLASSIFY_TIMEOUT_MS)
  if (classificationPending &&
      (millis() - classificationRequestTime >= CAM_CLASSIFY_TIMEOUT_MS)) {
    classificationPending = false;
    wsLog("warn", "Classification timeout — CAM did not respond");
#if SSCM_DEBUG
    Serial.println("[Classification] Timeout waiting for CAM response");
#endif
    relayClassificationErrorToBackend("CAM_RESPONSE_TIMEOUT");
  }

  // Serial commands
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    handleSerialCommand(cmd);
  }

  // Handle WiFi portal
  if (softAPStarted) {
    handleWiFiPortal();
  }

  /* ================= WIFI STATE MACHINE ================= */

  // Check if WiFi disconnected during runtime
  if (wifiConnected && WiFi.status() != WL_CONNECTED) {
#if SSCM_DEBUG
    Serial.println("WiFi disconnected! Attempting reconnect...");
#endif
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
    wifiRetryDelay = 5000; // Reset backoff so next disconnect starts fresh
    wifiRetryStart = 0;    // Clear any in-progress retry wait

    wifiServer.stop();
    WiFi.softAPdisconnect(true);

#if SSCM_DEBUG
    Serial.println("\n=== WiFi Connected ===");
    Serial.println("IP: " + WiFi.localIP().toString());
    Serial.println("======================\n");
#endif
    // wsLog not yet available (WS connects after WiFi) — logged after WS
    // connects

    // Register device with backend if not paired (HTTP - one time)
    if (!isPaired) {
      sendDeviceRegistration();
    }

    // Connect to WebSocket for real-time updates
    connectWebSocket();

    // Broadcast pairing again (in case CAM booted after main board)
#if SSCM_DEBUG
    Serial.println(
        "[ESP-NOW] Re-broadcasting pairing to CAM (WiFi connected)...");
#endif
    delay(100);
    sendPairingBroadcast();
  }

  /* WiFi retry logic */
  if (!wifiConnected && !softAPStarted) {
    if (millis() - lastWiFiRetry >= WIFI_RETRY_INTERVAL) {
      lastWiFiRetry = millis();

      wl_status_t status = WiFi.status();

      if (status == WL_CONNECTED) {
        return;
      }

      if (status == WL_IDLE_STATUS) {
#if SSCM_DEBUG
        Serial.println("WiFi idle, starting connection...");
#endif
        WiFi.begin(prefs.getString("ssid", "").c_str(),
                   prefs.getString("pass", "").c_str());
      } else if (status == WL_DISCONNECTED) {
#if SSCM_DEBUG
        Serial.println("WiFi disconnected, retrying...");
#endif
        WiFi.begin(prefs.getString("ssid", "").c_str(),
                   prefs.getString("pass", "").c_str());
      }

      // Timeout fallback — non-blocking retry (replacing delay() to keep loop()
      // alive)
      if (millis() - wifiStartTime > WIFI_TIMEOUT) {
        if (wifiRetryStart == 0) {
          // Enter retry wait period
#if SSCM_DEBUG
          Serial.println(
              "[WiFi] Timeout — credentials preserved, retrying in " +
              String(wifiRetryDelay / 1000) + "s");
#endif
          startSoftAP();
          wifiRetryStart = millis();
        } else if (millis() - wifiRetryStart >= wifiRetryDelay) {
          // Retry wait elapsed — attempt reconnect
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

  // Stop here if WiFi not ready
  if (!wifiConnected) {
    return;
  }

  /* ================= STATUS UPDATE (KEEP ALIVE) ================= */
  // Always send status updates (even when unpaired) to show device is
  // online/offline
  if (wsConnected && millis() - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
    lastStatusUpdate = millis();

    // Send status update via WebSocket (non-blocking)
    String statusMsg =
        "{\"type\":\"status-update\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(statusMsg);
    // Silent - keep-alive doesn't need logging
  }

  /* ================= SENSOR READINGS (BLOCKING) ================= */
  // Skip sensor readings when steppers are moving to prevent motor stuttering
  // pulseIn() blocks up to 30ms per ultrasonic, DHT22 blocks ~250ms
  if (!stepper1Moving && !stepper2Moving) {

    /* ================= DHT22 AUTOMATIC READING ================= */
    // Only read sensors if device is paired
    if (isPaired && millis() - lastDHTRead >= DHT_READ_INTERVAL) {
      lastDHTRead = millis();

      // Read DHT22 sensor
      bool readSuccess = readDHT11();

      // Send data via WebSocket only if reading was successful
      if (readSuccess && wsConnected) {
        sendDHTDataViaWebSocket();
      }
    }

    /* ================= ULTRASONIC AUTOMATIC READING ================= */
    // Only read sensors if device is paired
    if (isPaired && millis() - lastUltrasonicRead >= ULTRASONIC_READ_INTERVAL) {
      lastUltrasonicRead = millis();

      // Read both ultrasonic sensors (pulseIn blocks up to 30ms each)
      bool atomizerSuccess = readAtomizerLevel();
      bool foamSuccess = readFoamLevel();

      // Log combined reading
      if (atomizerSuccess || foamSuccess) {
#if SSCM_DEBUG
        Serial.println("[Level] Atomizer: " + String(currentAtomizerDistance) +
                       " cm | Foam: " + String(currentFoamDistance) + " cm");
#endif
      }

      // Send data via WebSocket if at least one reading was successful
      if ((atomizerSuccess || foamSuccess) && wsConnected) {
        sendUltrasonicDataViaWebSocket();
      }
    }
  }

  /* ================= SERVICE HANDLING ================= */
  // Handle service timer, relay control, and RGB lights
  handleService();
  handleDryingTemperature();
  handlePurge();

  // Small yield to prevent watchdog timeout (allows ESP32 to handle WiFi/system
  // tasks)
  yield();
}
