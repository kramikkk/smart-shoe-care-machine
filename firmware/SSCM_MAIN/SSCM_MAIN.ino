#define FIRMWARE_VERSION "1.0.18"
#define BOARD_NAME "SSCM-MAIN"

/**
 * Smart Shoe Care Machine - WiFi & Pairing with WebSocket
 * Firmware with WiFi configuration and real-time device pairing via WebSocket
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

// Serial print logging macro
#define LOG(msg) Serial.println(msg)

/* ===================== FORWARD DECLARATIONS ===================== */
// Payment (Required due to IRAM_ATTR pre-processor quirk)
void IRAM_ATTR handleCoinPulse();
void IRAM_ATTR handleBillPulse();

/* ===================== WIFI ===================== */
Preferences prefs;
WiFiServer wifiServer(80);          // HTTP server for captive portal (SoftAP provisioning mode)
bool wifiConnected = false;
unsigned long wifiRetryDelay = 5000; // Exponential backoff seed (ms); doubles each timeout, caps at 30s
unsigned long wifiRetryStart = 0;    // Timestamp when current backoff window began (0 = not in backoff)
bool softAPStarted = false;
unsigned long wifiStartTime = 0;     // Timestamp of the most recent connect attempt start
unsigned long lastWiFiRetry = 0;     // Timestamp of the last retry poll tick

#define WIFI_CONNECT_TIMEOUT 15000   // ms before restarting a stale connection attempt
#define WIFI_RETRY_INTERVAL   5000   // ms between retry poll checks in loop()

/* ===================== WEBSOCKET ===================== */
WebSocketsClient webSocket;
bool wsConnected = false;
bool wsInitialized = false;
const unsigned long WS_RECONNECT_INTERVAL = 5000;
// Deferred registration flag: set inside the WS event handler to avoid blocking
// the WS loop with a full HTTP request (connect + TLS + POST can take up to 20s).
bool pendingDeviceRegistration = false;
// Reconnect watchdog: counts consecutive DISCONNECTED events without an intervening CONNECTED.
// After WS_RECONNECT_RESET_THRESHOLD failures the SSL context is fully torn down and
// beginSSL() is re-issued from loop(), because the WebSocketsClient library's internal
// reconnect does not reset the TLS state and gets permanently stuck after a server-side timeout.
uint8_t wsConsecutiveDisconnects = 0;
static constexpr uint8_t WS_RECONNECT_RESET_THRESHOLD = 5;

/* ===================== STATUS UPDATE ===================== */
unsigned long lastStatusUpdate = 0;
const unsigned long STATUS_UPDATE_INTERVAL = 5000;

/* ===================== ESP-NOW - ESP32-CAM COMMUNICATION =====================
 */
// Pairing broadcast from MAIN to discover/configure a CAM board.
// Includes WiFi + backend endpoint so CAM can fully self-provision.
typedef struct {
  uint8_t type;
  char groupToken[10];
  char deviceId[24];
  char ssid[32];
  char password[64];
  char wsHost[64];
  uint16_t wsPort;
} PairingBroadcast;

// CAM response confirming pairing + providing current CAM LAN IP.
typedef struct {
  uint8_t type;
  char camOwnDeviceId[24];
  char camIp[20];
} PairingAck;

// Generic command/result message for CAM control and classification outcomes.
typedef struct {
  uint8_t type;
  uint8_t status;
  char shoeType[32];
  float confidence;
} CamMessage;

#define CAM_MSG_PAIR_REQUEST 1
#define CAM_MSG_PAIR_ACK 2
#define CAM_MSG_CLASSIFY_REQUEST 3
#define CAM_MSG_CLASSIFY_RESULT 4
#define CAM_MSG_STATUS_PING 5
#define CAM_MSG_STATUS_PONG 6
#define CAM_MSG_LED_ENABLE 7
#define CAM_MSG_LED_DISABLE 8
#define CAM_MSG_FACTORY_RESET 9

#define CAM_STATUS_OK 0
#define CAM_STATUS_ERROR 1
#define CAM_STATUS_TIMEOUT 2
#define CAM_STATUS_BUSY 3
#define CAM_STATUS_NOT_READY 4
#define CAM_STATUS_LOW_CONFIDENCE 5
#define CAM_STATUS_API_HANDLED 6

bool espNowInitialized = false;
bool camIsReady = false;
unsigned long lastCamHeartbeat = 0;
#define CAM_HEARTBEAT_TIMEOUT 60000
unsigned long lastCamPing = 0;
#define CAM_PING_INTERVAL 30000

// Actions deferred from ESP-NOW callback to loop() to avoid heavy work in radio context.
enum EspNowPending : uint8_t {
  ESPNOW_NONE           = 0, // Queue slot is empty
  ESPNOW_CAM_PAIRED     = 1, // CAM completed the pairing handshake; notify backend
  ESPNOW_API_HANDLED    = 2, // CAM sent CAM_STATUS_API_HANDLED (Gemini path)
  ESPNOW_CLASSIFY_LOG   = 3  // CAM classification-side status for observability only
};
#define ESPNOW_QUEUE_SIZE 4
// Small lock-protected queue used to hand off ESP-NOW callback work to loop().
// This avoids heavy operations inside radio callback context.
struct EspNowEntry {
  EspNowPending action;
  char message[48];
};
static EspNowEntry espNowQueue[ESPNOW_QUEUE_SIZE];
static uint8_t espNowQueueHead = 0;
static uint8_t espNowQueueTail = 0;
static portMUX_TYPE espNowMux = portMUX_INITIALIZER_UNLOCKED;

unsigned long lastPairingBroadcastTime = 0;
const unsigned long PAIRING_BROADCAST_INTERVAL = 5000;
bool pairingBroadcastStarted = false;

uint8_t camMacAddress[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
bool camMacPaired = false;
String pairedCamDeviceId = "";
String pairedCamIp = "";

uint8_t broadcastAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

bool classificationPending = false;
unsigned long classificationRequestTime = 0;
const unsigned long CAM_CLASSIFY_TIMEOUT_MS = 20000;

bool classificationLedOn = false;

/* ===================== COIN SLOT ===================== */
// Coin acceptor outputs pulses on falling edge: ₱1 = 1 pulse, ₱5 = 5 pulses, ₱10 = 10 pulses.
// ISR counts pulses; loop() finalises the value after the inter-pulse timeout expires.
#define COIN_SLOT_PIN 5
volatile unsigned long lastCoinPulseTime = 0;        // Timestamp of most recent pulse (ISR-updated)
volatile unsigned long lastCoinProcessedTime = 0;    // Timestamp of last batch finalization
volatile unsigned int currentCoinPulses = 0;         // Running pulse count for the current coin burst
unsigned int totalCoinPesos = 0;
const unsigned long COIN_PULSE_DEBOUNCE_TIME = 100;  // ms — ignore pulses within this window of each other
const unsigned long COIN_COMPLETE_TIMEOUT = 200;     // ms of silence after last pulse = burst is done
// Dead time after a coin batch is processed — prevents trailing ghost pulses
// from the coin acceptor mechanism from starting a new ₱1 count.
const unsigned long COIN_GUARD_TIME = 100;

/* ===================== BILL ACCEPTOR ===================== */
// Bill acceptor outputs 1 pulse per ₱10 inserted (e.g. ₱20 bill = 2 pulses, ₱100 = 10 pulses).
// Pulse counting and value calculation mirrors the coin slot pattern.
#define BILL_PULSE_PIN 4
volatile unsigned long lastBillPulseTime = 0;       // Timestamp of most recent bill pulse (ISR-updated)
volatile unsigned int currentBillPulses = 0;        // Running pulse count for the current bill burst
unsigned int totalBillPesos = 0;
unsigned int totalPesos = 0;                        // totalCoinPesos + totalBillPesos
const unsigned long BILL_PULSE_DEBOUNCE_TIME = 100; // ms — ignore pulses within this window
const unsigned long BILL_COMPLETE_TIMEOUT = 200;    // ms of silence after last pulse = bill accepted

/* ===================== PAYMENT CONTROL ===================== */
volatile bool paymentEnabled = false;
bool totalsDirty = false;
unsigned long lastTotalsSave = 0;
#define TOTALS_SAVE_INTERVAL 30000
volatile unsigned long paymentEnableTime = 0;
const unsigned long PAYMENT_STABILIZATION_DELAY = 100;
static portMUX_TYPE paymentMux = portMUX_INITIALIZER_UNLOCKED;

/* ===================== 8-CHANNEL RELAY ===================== */
// Relay board is active-HIGH (RELAY_ON = HIGH energises the coil).
// Actuator assignments (confirmed from service.ino):
#define RELAY_1_PIN 3   // Coin/bill acceptor power rail (enable-payment turns ON; disable-payment turns OFF)
#define RELAY_2_PIN 8   // Bottom exhaust fan (purge after drying/sterilizing)
#define RELAY_3_PIN 18  // Drying fan
#define RELAY_4_PIN 17  // Left PTC heater (drying)
#define RELAY_5_PIN 16  // Diaphragm pump (cleaning — soap/water spray)
#define RELAY_6_PIN 15  // Right PTC heater (drying)
#define RELAY_7_PIN 7   // Mist maker (sterilizing)
#define RELAY_8_PIN 6   // UVC light (sterilizing)

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
// Configurable drying setpoint (injected by backend from dashboard settings).
// Default 40°C; updated per start-service command via dryingTempSetpoint field.
//   <= setpoint → heaters ON, blower ON, exhaust OFF   (heat up toward target)
//   >  setpoint → heaters OFF, blower ON, exhaust ON   (vent to cool down)
float dryingTempSetpoint = 40.0; // °C — overridden by start-service payload each cycle
bool dryingHeaterOn  = false;    // True when relays 4 + 6 (PTC heaters) are active
bool dryingExhaustOn = false;    // True when relay 2 (bottom exhaust) is active for cooling

/* ===================== CLEANING SERVICE STATE ===================== */
// Cleaning uses a multi-phase state machine (cleaningPhase 1–4):
//   1: top brush descending (pump ON + side moving simultaneously)
//   2: top brush returning upward (pump still ON)
//   3: waiting for side to reach depth
//   4: brush active — direction driven by servo angle (0–60°=CCW, 60–120°=CW, 120–180°=CCW)
//      Phase 4 timing: 5s hold at 0° → sweep 0→180 → 5s hold at 180° → service timer ends
const long CLEANING_MAX_POSITION = 4800; // Top brush parked position (steps = 480mm up)
int cleaningPhase = 0;                   // 0 = idle, 1–4 = active phase (see above)
int brushMotorSpeed    = 255;            // PWM duty for brush motors during cleaning
int brushLastMotorDir  = 0;             // Last applied direction: 1=CW, -1=CCW, 0=unset
const unsigned long BRUSH_EDGE_PAUSE_MS = 10000; // Hold duration at 0° and 180° endpoints
bool brushInStartPause            = false; // true while waiting the 10s hold at 0° before sweep
unsigned long brushStartPauseTime = 0;    // millis() when the 0° hold began
bool brushTopRepeatTriggered  = false;    // becomes true when servo first reaches 170° in phase 4
bool brushTopRepeatDescending = false;    // top brush going down for repeat pass (pump ON)
bool brushTopRepeatAscending  = false;    // top brush going back up after repeat (pump OFF)

/* ===================== DHT11 SENSOR ===================== */
#define DHT_PIN 9
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);
float currentTemperature = 0.0;
float currentHumidity = 0.0;
unsigned long lastDHTRead = 0;
const unsigned long DHT_READ_INTERVAL = 5000;
void sendDHTDataViaWebSocket(bool invalid = false);

/* ===================== ULTRASONIC SENSORS ===================== */
#define ATOMIZER_TRIG_PIN 10
#define ATOMIZER_ECHO_PIN 11
#define FOAM_TRIG_PIN 12
#define FOAM_ECHO_PIN 13
int currentAtomizerDistance = 0;
int currentFoamDistance = 0;
int currentAtomizerLevel = 0;
int currentFoamLevel = 0;
unsigned long lastUltrasonicRead = 0;
const unsigned long ULTRASONIC_READ_INTERVAL = 5000;

/* ===================== SERVO MOTORS ===================== */
// Left and right servos are mirrored: leftPos + rightPos always = 180°.
// They hold the shoe in place; 0° = open/release, 90° = mid, 180° = clamped.
#define SERVO_LEFT_PIN  19
#define SERVO_RIGHT_PIN 14
Servo servoLeft;
Servo servoRight;
int currentLeftPosition  = 0;    // Current angle (degrees) of left servo
int currentRightPosition = 180;  // Current angle (degrees) of right servo
int targetLeftPosition   = 0;    // Destination angle for left servo
int targetRightPosition  = 180;  // Destination angle for right servo
bool servosMoving = false;
unsigned long lastServoUpdate = 0;
const unsigned long SERVO_UPDATE_INTERVAL = 15;    // ms between each step tick in updateServoPositions()
// Speed control: each tick advances by 1° only when servoStepCounter reaches servoStepInterval.
// SLOW = 105 ticks × 15ms = ~1.575s to travel 180° (smooth clamping motion during cleaning sweep).
// FAST = 1  tick  × 15ms = ~2.7s  to travel 180° at maximum step rate (open/release).
const int SERVO_SLOW_STEP_INTERVAL = 105;
const int SERVO_FAST_STEP_INTERVAL = 1;
int servoStepInterval = SERVO_SLOW_STEP_INTERVAL;  // Active speed — switched by setServoPositions()
int servoStepCounter  = 0;                          // Counts update ticks; resets when it hits servoStepInterval

/* ===================== DC MOTORS (DRV8871) ===================== */
// Two DRV8871 H-bridge drivers control the brush motors (left = CW, right = CCW mirror).
// Speed is PWM duty on IN1/IN2; both HIGH = brake, both LOW = coast.
#define MOTOR_LEFT_IN1_PIN  21
#define MOTOR_LEFT_IN2_PIN  47
#define MOTOR_RIGHT_IN1_PIN 48
#define MOTOR_RIGHT_IN2_PIN 45
const int MOTOR_PWM_FREQ       = 1000; // 1 kHz — above audible range, within DRV8871 spec
const int MOTOR_PWM_RESOLUTION = 8;    // 8-bit = 0–255 speed range via ledcWrite()
int currentLeftMotorSpeed  = 0;        // Active duty (-255 to 255; negative = reverse)
int currentRightMotorSpeed = 0;

/* ===================== STEPPER 1 — TOP BRUSH (TB6600) ===================== */
// Drives the vertical axis (top brush descends/ascends over the shoe).
// Lead screw pitch: 2mm/rev × 200 steps/rev full-step = 10 steps/mm.
// Travel range: 0 (bottom / brush contact) → CLEANING_MAX_POSITION 4800 steps (48mm, parked up).
#define STEPPER1_STEP_PIN 40
#define STEPPER1_DIR_PIN  38
const int STEPPER1_STEPS_PER_REV  = 200;   // Full-step 1.8° motor = 200 steps/revolution
const int STEPPER1_MICROSTEPS     = 1;     // TB6600 set to full-step mode
const int STEPPER1_STEPS_PER_MM   = 10;    // 2mm lead screw pitch: 200 steps / 20mm = 10 steps/mm
const int STEPPER1_MAX_SPEED      = 800;   // Steps/sec cap (~80mm/s); above this the motor stalls
const unsigned long STEPPER1_MIN_PULSE_WIDTH = 2; // µs — minimum TB6600 STEP pulse high time
long currentStepper1Position = 0;          // Steps from home (0 = brush contact point)
long targetStepper1Position  = 0;
int  stepper1Speed       = 800;            // Active steps/sec
bool stepper1Moving      = false;
unsigned long lastStepper1Update  = 0;     // micros() timestamp of last step
unsigned long stepper1StepInterval = 1250; // µs between steps at 800 steps/sec (1,000,000/800)

/* ===================== STEPPER 2 — SIDE BRUSH (TB6600) ===================== */
// Drives the horizontal axis (side brush pushes inward toward the shoe).
// Lead screw pitch: 1mm/rev × 200 steps/rev full-step = 200 steps/mm.
// Travel range: 0 (retracted / home) → STEPPER2_MAX_POSITION 20000 steps (100mm, full depth).
// Care depth targets: gentle=18000 (90mm), normal=19000 (95mm), strong=20000 (100mm).
#define STEPPER2_STEP_PIN 41
#define STEPPER2_DIR_PIN  42
const int STEPPER2_STEPS_PER_REV  = 200;    // Full-step 1.8° motor = 200 steps/revolution
const int STEPPER2_MICROSTEPS     = 1;      // TB6600 set to full-step mode
const int STEPPER2_STEPS_PER_MM   = 200;    // 1mm lead screw pitch: 200 steps / 1mm = 200 steps/mm
const int STEPPER2_MAX_SPEED      = 24000;  // Steps/sec cap (~120mm/s); finer pitch allows higher rate
const long STEPPER2_MAX_POSITION  = 20000;  // 20000 steps = 100mm total travel (hard rail limit)
const unsigned long STEPPER2_MIN_PULSE_WIDTH = 2; // µs — minimum TB6600 STEP pulse high time
long currentStepper2Position = 0;           // Steps from home (0 = fully retracted)
long targetStepper2Position  = 0;
int  stepper2Speed        = 1500;           // Active steps/sec
bool stepper2Moving       = false;
unsigned long lastStepper2Update   = 0;     // micros() timestamp of last step
unsigned long stepper2StepInterval = 667;   // µs between steps at 1500 steps/sec (1,000,000/1500)

/* ===================== WS2812B LED STRIP ===================== */
#define RGB_DATA_PIN 39
#define RGB_NUM_LEDS 58
Adafruit_NeoPixel strip(RGB_NUM_LEDS, RGB_DATA_PIN, NEO_GRB + NEO_KHZ800);
int currentRed = 0;
int currentGreen = 0;
int currentBlue = 0;

/* ===================== PAIRING ===================== */
String pairingCode = "";
String deviceId = "";
String groupToken = "";
bool isPaired = false;
bool camSynced = false;
String camDeviceId = "";

/* ===================== SERVICE CHECKPOINT (NVS) ===================== */
// Written at every cleaning phase boundary + 30s periodic tick while serviceActive.
// On boot: svc_act == true means power was cut mid-service — hold until WS reconnects,
// then send service-interrupted to backend and wait for resume-service / skip-resume.
String   currentServiceTxId  = "";  // Backend transaction ID for the active service
bool     pendingServiceResume = false; // True while a boot-time checkpoint awaits resume/skip

// Fields loaded from NVS on boot (only valid when pendingServiceResume == true)
String   resumeSvcType  = "";
String   resumeSvcShoe  = "";
String   resumeSvcCare  = "";
uint32_t resumeSvcRemMs = 0;  // remaining ms at the last checkpoint save
uint8_t  resumeSvcPhase = 0;
uint8_t  resumeSvcCycle = 0;
String   resumeSvcTxId  = "";

// Preset side brush depth for the current cleaning cycle (steps).
// Set in startService() and used by handleService() to compute the servo-angle-based pull-back.
long cleaningSideDepthSteps = 0;

unsigned long lastCheckpointSave = 0;
const unsigned long CHECKPOINT_SAVE_INTERVAL = 30000; // ms — periodic NVS save during service

/* ===================== WIFI POST-CONNECT STABILISATION ===================== */
// Non-blocking 3s stabilisation window after WiFi connects.
// delay() in loop() would freeze stepper homing — use millis() instead.
static bool wifiPostConnectPending = false;
static unsigned long wifiPostConnectAt = 0;
#define WIFI_STABILISE_MS 3000

/* ===================== BACKEND URL ===================== */
// WARNING: set USE_LOCAL_BACKEND to 0 before flashing production firmware.
// Leaving it as 1 points the device at a local IP that will not be reachable in the field.
#define USE_LOCAL_BACKEND 0
#if USE_LOCAL_BACKEND
#define BACKEND_HOST_STR "192.168.43.160"
#define BACKEND_PORT_NUM 3000
#define BACKEND_URL_STR "http://192.168.43.160:3000"
#else
#define BACKEND_HOST_STR "smart-shoe-care-machine.onrender.com"
#define BACKEND_PORT_NUM 443
#define BACKEND_URL_STR "https://smart-shoe-care-machine.onrender.com"
#endif

const char *BACKEND_HOST = BACKEND_HOST_STR;
const int BACKEND_PORT = BACKEND_PORT_NUM;
const char *BACKEND_URL = BACKEND_URL_STR;

/* ===================== SETUP ===================== */
// Boot sequence initializes:
// - persisted machine state (IDs, pair status, counters, actuator positions)
// - all hardware drivers/IO
// - network stack (STA or SoftAP fallback)
void setup() {
  Serial.begin(115200);
  delay(100);
  LOG("\n\n===================================");
  LOG("  [BOOT] SSCM MAIN");
  LOG("  Firmware v" + String(FIRMWARE_VERSION));
  LOG("===================================\n");

  prefs.begin("sscm", false);

  currentStepper1Position = prefs.getLong("s1pos", 0);
  currentStepper2Position = prefs.getLong("s2pos", 0);

  // Service checkpoint detection — if svc_act is true a service was active during power cut.
  pendingServiceResume = prefs.getBool("svc_act", false);
  if (pendingServiceResume) {
    resumeSvcType  = prefs.getString("svc_type", "");
    resumeSvcShoe  = prefs.getString("svc_shoe", "");
    resumeSvcCare  = prefs.getString("svc_care", "");
    resumeSvcRemMs = prefs.getUInt("svc_rem", 0);
    resumeSvcPhase = (uint8_t)prefs.getUChar("svc_phase", 0);
    resumeSvcCycle = (uint8_t)prefs.getUChar("svc_cycle", 0);
    resumeSvcTxId  = prefs.getString("svc_txid", "");
    LOG("[BOOT] Service checkpoint found — type:" + resumeSvcType +
        " rem:" + String(resumeSvcRemMs / 1000) + "s txid:" + resumeSvcTxId);
  }

  // Physical failsafe: hold BOOT during power-on to wipe configuration.
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
    delay(3000);
    if (digitalRead(0) == LOW)
      factoryReset();
  }

  // --- Sensors ---
  dht.begin();

  pinMode(ATOMIZER_TRIG_PIN, OUTPUT);
  pinMode(ATOMIZER_ECHO_PIN, INPUT);
  digitalWrite(ATOMIZER_TRIG_PIN, LOW);  // Idle state: TRIG must be LOW before a measurement

  pinMode(FOAM_TRIG_PIN, OUTPUT);
  pinMode(FOAM_ECHO_PIN, INPUT);
  digitalWrite(FOAM_TRIG_PIN, LOW);

  // --- Servo motors (shoe holder) ---
  servoLeft.attach(SERVO_LEFT_PIN);
  servoRight.attach(SERVO_RIGHT_PIN);
  servoLeft.write(0);    // Open position
  servoRight.write(180); // Mirrored open position
  currentLeftPosition  = 0;
  currentRightPosition = 180;
  targetLeftPosition   = 0;
  targetRightPosition  = 180;

  // --- DC brush motors (DRV8871) ---
  pinMode(MOTOR_LEFT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_LEFT_IN2_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2_PIN, OUTPUT);
  // Drive LOW before attaching LEDC to avoid a brief unintended output
  digitalWrite(MOTOR_LEFT_IN1_PIN, LOW);
  digitalWrite(MOTOR_LEFT_IN2_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN1_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN2_PIN, LOW);

  ledcAttach(MOTOR_LEFT_IN1_PIN,  MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN1_PIN,  0);
  ledcAttach(MOTOR_LEFT_IN2_PIN,  MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN2_PIN,  0);
  ledcAttach(MOTOR_RIGHT_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
  ledcAttach(MOTOR_RIGHT_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  motorsCoast();  // Both IN pins LOW = high-impedance coast (no braking)

  // --- Stepper motors (TB6600) ---
  pinMode(STEPPER1_STEP_PIN, OUTPUT);
  pinMode(STEPPER1_DIR_PIN,  OUTPUT);
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  digitalWrite(STEPPER1_DIR_PIN,  LOW);
  setStepper1Speed(800);   // 800 steps/sec = ~80mm/s on top axis

  pinMode(STEPPER2_STEP_PIN, OUTPUT);
  pinMode(STEPPER2_DIR_PIN,  OUTPUT);
  digitalWrite(STEPPER2_STEP_PIN, LOW);
  digitalWrite(STEPPER2_DIR_PIN,  LOW);
  setStepper2Speed(1500);  // 1500 steps/sec = ~7.5mm/s on side axis

  // Restore mechanical baseline after reboot before accepting operations.
  if (currentStepper1Position != CLEANING_MAX_POSITION)
    stepper1MoveTo(CLEANING_MAX_POSITION); // Park top brush at top (away from shoe)
  if (currentStepper2Position != 0)
    stepper2MoveTo(0);                     // Retract side brush fully

  // --- LED strip (WS2812B) ---
  strip.begin();
  strip.setBrightness(100);
  strip.show();  // Push blank/off state to clear any power-on garbage

  // --- Relay board ---
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  pinMode(RELAY_3_PIN, OUTPUT);
  pinMode(RELAY_4_PIN, OUTPUT);
  pinMode(RELAY_5_PIN, OUTPUT);
  pinMode(RELAY_6_PIN, OUTPUT);
  pinMode(RELAY_7_PIN, OUTPUT);
  pinMode(RELAY_8_PIN, OUTPUT);
  allRelaysOff();  // Ensure all actuators are off at boot

  delay(200);  // Short settle before attaching payment interrupts

  // --- Payment hardware (ISR-driven) ---
  pinMode(COIN_SLOT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_SLOT_PIN), handleCoinPulse, FALLING);
  pinMode(BILL_PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BILL_PULSE_PIN), handleBillPulse, FALLING);

  totalCoinPesos = prefs.getUInt("totalCoinPesos", 0);
  totalBillPesos = prefs.getUInt("totalBillPesos", 0);
  totalPesos = totalCoinPesos + totalBillPesos;

  deviceId = prefs.getString("deviceId", "");
  if (deviceId.length() == 0) {
    deviceId = generateDeviceId();
    prefs.putString("deviceId", deviceId);
  }
  LOG("[BOOT] Device ID: " + deviceId);

  groupToken = prefs.getString("groupToken", "");
  if (groupToken.length() == 0) {
    groupToken = generateGroupToken();
    prefs.putString("groupToken", groupToken);
  }
  LOG("[BOOT] GroupToken: " + groupToken);

  isPaired = prefs.getBool("paired", false);
  if (!isPaired) {
    pairingCode = generatePairingCode();
    LOG("[BOOT] Pairing Code: " + pairingCode);
  }

  String storedSSID = prefs.getString("ssid", "");
  // Provisioning mode if no WiFi credentials exist; otherwise boot into AP_STA mode
  // so the portal stays reachable while the STA connection attempt is in-flight.
  if (storedSSID.length() == 0) {
    startSoftAP();
  } else {
    WiFi.mode(WIFI_AP_STA);
    delay(100);
    initESPNow();
    delay(100);
    connectWiFi();
  }
  LOG("[BOOT] Setup complete");
}

/* ===================== LOOP ===================== */
bool otaInitialized = false;

// Main scheduler loop: cooperatively advances IO, motion, payments, network,
// service logic, and telemetry without long blocking delays.
void loop() {
  if (otaInitialized)
    ArduinoOTA.handle();
  // Only drive the WS library after we have explicitly opened a connection via
  // connectWebSocket() (wsInitialized = true). This prevents the library's
  // internal auto-reconnect from firing between WiFi coming up and the 3s
  // stabilisation window expiring, which would cause a double-connect sequence.
  if (wifiConnected && wsInitialized)
    webSocket.loop();

  // Watchdog fallback: if the reconnect watchdog cleared wsInitialized (after
  // WS_RECONNECT_RESET_THRESHOLD consecutive disconnects), re-init the WS here rather
  // than waiting for the next WiFi disconnect/reconnect cycle.
  // beginSSL() blocks during the TLS handshake — only run when WiFi is stable and
  // not in the middle of the initial post-connect stabilisation window.
  if (wifiConnected && !wsInitialized && !wifiPostConnectPending) {
    connectWebSocket();
  }

  // Drain deferred registration: sendDeviceRegistration() blocks for up to 20s (TLS + HTTP)
  // so it must not run inside the WS event handler where it would starve webSocket.loop().
  if (pendingDeviceRegistration && wifiConnected) {
    pendingDeviceRegistration = false;
    sendDeviceRegistration();
  }

  // Consume deferred ESP-NOW actions produced by callbacks.
  // All backend/WebSocket side-effects are executed here in normal task context.
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
      case ESPNOW_CAM_PAIRED:
        sendCamPairedToBackend();
        break;
      case ESPNOW_API_HANDLED:
        wsLog("info", "CAM: Gemini API handled classification result");
        break;
      case ESPNOW_CLASSIFY_LOG:
        LOG("[CAM->MAIN] " + String(entry.message));
        if (wsConnected) {
          wsLog("warn", "Classification status: " + String(entry.message));
          // Kiosk listens for type classification-busy (not firmware-log).
          if (strcmp(entry.message, "CAM_BUSY") == 0) {
            String busy = "{\"type\":\"classification-busy\",\"deviceId\":\"" + deviceId + "\"}";
            webSocket.sendTXT(busy);
          }
        }
        break;
      default:
        break;
      }
    }
  }

  updateServoPositions();
  updateStepper1Position();
  updateStepper2Position();

  // Coin/bill pulses are ISR-counted; loop finalizes a payment only after
  // inter-pulse timeout confirms the pulse burst is complete.
  if (paymentEnabled && currentCoinPulses > 0) {
    if (millis() - lastCoinPulseTime >= COIN_COMPLETE_TIMEOUT) {
      portENTER_CRITICAL(&paymentMux);
      unsigned int coinValue = currentCoinPulses;
      currentCoinPulses = 0;
      lastCoinProcessedTime = millis();
      portEXIT_CRITICAL(&paymentMux);
      totalCoinPesos += coinValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty = true;
      if (isPaired && wsConnected) {
        String coinMsg = "{\"type\":\"coin-inserted\",\"deviceId\":\"" +
                         deviceId + "\",\"coinValue\":" + String(coinValue) +
                         ",\"totalCoinPesos\":" + String(totalCoinPesos) +
                         ",\"totalBillPesos\":" + String(totalBillPesos) +
                         ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(coinMsg);
      }
    }
  }

  if (paymentEnabled && currentBillPulses > 0) {
    if (millis() - lastBillPulseTime >= BILL_COMPLETE_TIMEOUT) {
      portENTER_CRITICAL(&paymentMux);
      unsigned int billPulses = currentBillPulses;
      currentBillPulses = 0;
      portEXIT_CRITICAL(&paymentMux);
      unsigned int billValue = billPulses * 10;
      totalBillPesos += billValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty = true;
      if (isPaired && wsConnected) {
        String billMsg = "{\"type\":\"bill-inserted\",\"deviceId\":\"" +
                         deviceId + "\",\"billValue\":" + String(billValue) +
                         ",\"totalCoinPesos\":" + String(totalCoinPesos) +
                         ",\"totalBillPesos\":" + String(totalBillPesos) +
                         ",\"totalPesos\":" + String(totalPesos) + "}";
        webSocket.sendTXT(billMsg);
      }
    }
  }

  if (totalsDirty && (millis() - lastTotalsSave >= TOTALS_SAVE_INTERVAL)) {
    prefs.putUInt("totalCoinPesos", totalCoinPesos);
    prefs.putUInt("totalBillPesos", totalBillPesos);
    lastTotalsSave = millis();
    totalsDirty = false;
  }

  // CAM liveness monitor:
  // - periodic ping while paired/ready
  // - mark offline on heartbeat timeout
  // - resume pairing broadcasts until CAM is available again
  if (camIsReady && camMacPaired &&
      (millis() - lastCamPing >= CAM_PING_INTERVAL)) {
    lastCamPing = millis();
    CamMessage ping;
    memset(&ping, 0, sizeof(ping));
    ping.type = CAM_MSG_STATUS_PING;
    esp_now_send(camMacAddress, (uint8_t *)&ping, sizeof(ping));
  }

  if (camIsReady && (millis() - lastCamHeartbeat > CAM_HEARTBEAT_TIMEOUT)) {
    camIsReady = false;
    lastCamHeartbeat = millis();
  }

  if (!camIsReady && pairingBroadcastStarted) {
    if (millis() - lastPairingBroadcastTime >= PAIRING_BROADCAST_INTERVAL) {
      sendPairingBroadcast();
    }
  }

  if (classificationPending &&
      (millis() - classificationRequestTime >= CAM_CLASSIFY_TIMEOUT_MS)) {
    classificationPending = false;
    LOG("[CAM->MAIN] Classification timeout waiting for CAM response");
    if (wsConnected) wsLog("warn", "Classification status: CAM_RESPONSE_TIMEOUT");
  }

  if (Serial.available())
    handleSerialCommand(Serial.readStringUntil('\n'));
  if (softAPStarted)
    handleWiFiPortal();

  if (wifiConnected && WiFi.status() != WL_CONNECTED) {
    LOG("[WIFI] Lost connection (status=" + String(wifiStatusStr(WiFi.status())) + ") — reconnecting");
    wifiConnected = false;
    wsConnected = false;
    // Stop the WS library from attempting reconnects while WiFi is down.
    // webSocket.loop() is gated on wifiConnected, so this call drains state cleanly.
    webSocket.disconnect();
    wsInitialized = false;
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
    wifiServer.stop();
    WiFi.softAPdisconnect(true);
    LOG("[WIFI] Connected — IP: " + WiFi.localIP().toString() +
        "  RSSI: " + String(WiFi.RSSI()) + " dBm" +
        "  elapsed: " + String((millis() - wifiStartTime) / 1000) + "s");
    LOG("[WIFI] Stabilising 3s before WebSocket (steppers keep running)");
    wifiPostConnectAt = millis();
    wifiPostConnectPending = true;
  }

  // Post-connect gate: wait for TCP/IP settle + motion idle before SSL WS init.
  // This prevents blocking handshake from starving time-critical stepper updates.
  // Post-connect: wait for TCP/IP to settle (3s) AND stepper homing to finish
  // before opening the WebSocket. beginSSL() blocks the loop during the SSL
  // handshake — starting it mid-move stalls the stepper bit-banging.
  if (wifiPostConnectPending && millis() - wifiPostConnectAt >= WIFI_STABILISE_MS
      && !stepper1Moving && !stepper2Moving) {
    wifiPostConnectPending = false;
    if (!isPaired)
      sendDeviceRegistration();
    LOG("[WS] Powering up connection...");
    webSocket.disconnect();
    wsInitialized = false;
    connectWebSocket();
    sendPairingBroadcast();
  }

  if (!wifiConnected) {
    if (millis() - lastWiFiRetry >= WIFI_RETRY_INTERVAL) {
      lastWiFiRetry = millis();
      wl_status_t status = WiFi.status();
      unsigned long elapsed = (millis() - wifiStartTime) / 1000;
      // Retry on definitive failures immediately.
      // Also restart a stale attempt after WIFI_CONNECT_TIMEOUT — WL_DISCONNECTED
      // is ambiguous (used both while associating and after a silent AP disappearance),
      // so the timeout catches the case where no failure code is ever emitted.
      bool definiteFail = (status == WL_CONNECT_FAILED ||
                           status == WL_NO_SSID_AVAIL  ||
                           status == WL_CONNECTION_LOST);
      bool stale        = (millis() - wifiStartTime > WIFI_CONNECT_TIMEOUT);
      if (definiteFail || stale) {
        connectWiFi();
      } else {
        LOG("[WIFI] Waiting... " + String(elapsed) + "s");
      }
    }
  }

  if (!wifiConnected)
    return;

  // Lightweight health heartbeat for dashboard/backend synchronization.
  if (wsConnected && millis() - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
    lastStatusUpdate = millis();
    String statusMsg = "{\"type\":\"status-update\",\"deviceId\":\"" +
                       deviceId +
                       "\",\"camSynced\":" + (camIsReady ? "true" : "false") +
                       ",\"isPaired\":" + (isPaired ? "true" : "false") + "}";
    webSocket.sendTXT(statusMsg);
  }

  // Sensor telemetry only when paired and motion is idle to reduce contention.
  if (wsConnected && !stepper1Moving && !stepper2Moving) {
    if (isPaired && millis() - lastDHTRead >= DHT_READ_INTERVAL) {
      lastDHTRead = millis();
      if (readDHT11())
        sendDHTDataViaWebSocket();
      else
        sendDHTDataViaWebSocket(true);
    }
    if (isPaired && millis() - lastUltrasonicRead >= ULTRASONIC_READ_INTERVAL) {
      lastUltrasonicRead = millis();
      readAtomizerLevel();
      readFoamLevel();
      sendUltrasonicDataViaWebSocket();
    }
  }

  // Periodic NVS checkpoint — keep elapsed time current every 30s while a service runs.
  if (serviceActive && millis() - lastCheckpointSave >= CHECKPOINT_SAVE_INTERVAL) {
    saveServiceCheckpoint();
  }

  handleService();
  handleDryingTemperature();
  handlePurge();

  yield();
}
