#define FIRMWARE_VERSION "1.0.3"
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
WiFiServer wifiServer(80);
bool wifiConnected = false;
unsigned long wifiRetryDelay = 5000;
unsigned long wifiRetryStart = 0;
bool softAPStarted = false;
unsigned long wifiStartTime = 0;
unsigned long lastWiFiRetry = 0;

#define WIFI_TIMEOUT 60000
#define WIFI_RETRY_INTERVAL 5000

/* ===================== WEBSOCKET ===================== */
WebSocketsClient webSocket;
bool wsConnected = false;
bool wsInitialized = false;
const unsigned long WS_RECONNECT_INTERVAL = 5000;

/* ===================== STATUS UPDATE ===================== */
unsigned long lastStatusUpdate = 0;
const unsigned long STATUS_UPDATE_INTERVAL = 5000;

/* ===================== ESP-NOW - ESP32-CAM COMMUNICATION =====================
 */
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

String lastClassificationResult = "";
float lastClassificationConfidence = 0.0;
bool classificationLedOn = false;

/* ===================== COIN SLOT ===================== */
#define COIN_SLOT_PIN 5
volatile unsigned long lastCoinPulseTime = 0;
volatile unsigned int currentCoinPulses = 0;
unsigned int totalCoinPesos = 0;
const unsigned long COIN_PULSE_DEBOUNCE_TIME = 100;
const unsigned long COIN_COMPLETE_TIMEOUT = 500;

/* ===================== BILL ACCEPTOR ===================== */
#define BILL_PULSE_PIN 4
volatile unsigned long lastBillPulseTime = 0;
volatile unsigned int currentBillPulses = 0;
unsigned int totalBillPesos = 0;
unsigned int totalPesos = 0;
const unsigned long BILL_PULSE_DEBOUNCE_TIME = 100;
const unsigned long BILL_COMPLETE_TIMEOUT = 500;

/* ===================== PAYMENT CONTROL ===================== */
volatile bool paymentEnabled = false;
bool totalsDirty = false;
unsigned long lastTotalsSave = 0;
#define TOTALS_SAVE_INTERVAL 30000
volatile unsigned long paymentEnableTime = 0;
const unsigned long PAYMENT_STABILIZATION_DELAY = 3000;
static portMUX_TYPE paymentMux = portMUX_INITIALIZER_UNLOCKED;

/* ===================== 8-CHANNEL RELAY ===================== */
#define RELAY_1_PIN 3
#define RELAY_2_PIN 8
#define RELAY_3_PIN 18
#define RELAY_4_PIN 17
#define RELAY_5_PIN 16
#define RELAY_6_PIN 15
#define RELAY_7_PIN 7
#define RELAY_8_PIN 6

#define RELAY_ON HIGH
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
const float DRYING_TEMP_LOW = 35.0;
const float DRYING_TEMP_HIGH = 40.0;
bool dryingHeaterOn = false;
bool dryingExhaustOn = false;

/* ===================== CLEANING SERVICE STATE ===================== */
const long CLEANING_MAX_POSITION = 4800;
int cleaningPhase = 0;
const unsigned long BRUSH_DURATION_MS = 30000;
const unsigned long BRUSH_COAST_MS = 500;
const int BRUSH_TOTAL_CYCLES = 10;
const int BRUSH_MOTOR_SPEED = 255;
int brushCurrentCycle = 0;
unsigned long brushPhaseStartTime = 0;
int brushNextPhase = 0;

/* ===================== DHT11 SENSOR ===================== */
#define DHT_PIN 9
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);
float currentTemperature = 0.0;
float currentHumidity = 0.0;
unsigned long lastDHTRead = 0;
const unsigned long DHT_READ_INTERVAL = 5000;

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
#define SERVO_LEFT_PIN 19
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

/* ===================== DC MOTORS ===================== */
#define MOTOR_LEFT_IN1_PIN 21
#define MOTOR_LEFT_IN2_PIN 47
#define MOTOR_RIGHT_IN1_PIN 48
#define MOTOR_RIGHT_IN2_PIN 45
const int MOTOR_PWM_FREQ = 1000;
const int MOTOR_PWM_RESOLUTION = 8;
int currentLeftMotorSpeed = 0;
int currentRightMotorSpeed = 0;

/* ===================== STEPPER 1 (TOP) ===================== */
#define STEPPER1_STEP_PIN 40
#define STEPPER1_DIR_PIN 38
const int STEPPER1_STEPS_PER_REV = 200;
const int STEPPER1_MICROSTEPS = 1;
const int STEPPER1_STEPS_PER_MM = 10;
const int STEPPER1_MAX_SPEED = 800;
const unsigned long STEPPER1_MIN_PULSE_WIDTH = 2;
long currentStepper1Position = 0;
long targetStepper1Position = 0;
int stepper1Speed = 800;
bool stepper1Moving = false;
unsigned long lastStepper1Update = 0;
unsigned long stepper1StepInterval = 1250;

/* ===================== STEPPER 2 (SIDE) ===================== */
#define STEPPER2_STEP_PIN 41
#define STEPPER2_DIR_PIN 42
const int STEPPER2_STEPS_PER_REV = 200;
const int STEPPER2_MICROSTEPS = 1;
const int STEPPER2_STEPS_PER_MM = 200;
const int STEPPER2_MAX_SPEED = 24000;
const long STEPPER2_MAX_POSITION = 20000;
const unsigned long STEPPER2_MIN_PULSE_WIDTH = 2;
long currentStepper2Position = 0;
long targetStepper2Position = 0;
int stepper2Speed = 1500;
bool stepper2Moving = false;
unsigned long lastStepper2Update = 0;
unsigned long stepper2StepInterval = 667;

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

/* ===================== BACKEND URL ===================== */
#define USE_LOCAL_BACKEND 0
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

/* ===================== SETUP ===================== */
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

  // Factory reset via BOOT button
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
    delay(3000);
    if (digitalRead(0) == LOW)
      factoryReset();
  }

  dht.begin();

  pinMode(ATOMIZER_TRIG_PIN, OUTPUT);
  pinMode(ATOMIZER_ECHO_PIN, INPUT);
  digitalWrite(ATOMIZER_TRIG_PIN, LOW);

  pinMode(FOAM_TRIG_PIN, OUTPUT);
  pinMode(FOAM_ECHO_PIN, INPUT);
  digitalWrite(FOAM_TRIG_PIN, LOW);

  servoLeft.attach(SERVO_LEFT_PIN);
  servoRight.attach(SERVO_RIGHT_PIN);
  servoLeft.write(0);
  servoRight.write(180);
  currentLeftPosition = 0;
  currentRightPosition = 180;
  targetLeftPosition = 0;
  targetRightPosition = 180;

  pinMode(MOTOR_LEFT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_LEFT_IN2_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN1_PIN, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2_PIN, OUTPUT);
  digitalWrite(MOTOR_LEFT_IN1_PIN, LOW);
  digitalWrite(MOTOR_LEFT_IN2_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN1_PIN, LOW);
  digitalWrite(MOTOR_RIGHT_IN2_PIN, LOW);

  ledcAttach(MOTOR_LEFT_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
  ledcAttach(MOTOR_LEFT_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  ledcAttach(MOTOR_RIGHT_IN1_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
  ledcAttach(MOTOR_RIGHT_IN2_PIN, MOTOR_PWM_FREQ, MOTOR_PWM_RESOLUTION);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  motorsCoast();

  pinMode(STEPPER1_STEP_PIN, OUTPUT);
  pinMode(STEPPER1_DIR_PIN, OUTPUT);
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  digitalWrite(STEPPER1_DIR_PIN, LOW);
  setStepper1Speed(800);

  pinMode(STEPPER2_STEP_PIN, OUTPUT);
  pinMode(STEPPER2_DIR_PIN, OUTPUT);
  digitalWrite(STEPPER2_STEP_PIN, LOW);
  digitalWrite(STEPPER2_DIR_PIN, LOW);
  setStepper2Speed(1500);

  if (currentStepper1Position != CLEANING_MAX_POSITION)
    stepper1MoveTo(CLEANING_MAX_POSITION);
  if (currentStepper2Position != 0)
    stepper2MoveTo(0);

  strip.begin();
  strip.setBrightness(100);
  strip.show();

  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  pinMode(RELAY_3_PIN, OUTPUT);
  pinMode(RELAY_4_PIN, OUTPUT);
  pinMode(RELAY_5_PIN, OUTPUT);
  pinMode(RELAY_6_PIN, OUTPUT);
  pinMode(RELAY_7_PIN, OUTPUT);
  pinMode(RELAY_8_PIN, OUTPUT);
  allRelaysOff();

  delay(200);

  pinMode(COIN_SLOT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_SLOT_PIN), handleCoinPulse,
                  FALLING);
  pinMode(BILL_PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BILL_PULSE_PIN), handleBillPulse,
                  FALLING);

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
  if (storedSSID.length() == 0) {
    startSoftAP();
  } else {
    WiFi.mode(WIFI_STA);
    delay(100);
    initESPNow();
    delay(100);
    connectWiFi();
  }
  LOG("[BOOT] Setup complete");
}

/* ===================== LOOP ===================== */
bool otaInitialized = false;

void loop() {
  if (otaInitialized)
    ArduinoOTA.handle();
  webSocket.loop();

  // Dispatch deferred ESP-NOW results
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

  updateServoPositions();
  updateStepper1Position();
  updateStepper2Position();

  // Handle payments
  if (paymentEnabled && currentCoinPulses > 0) {
    if (millis() - lastCoinPulseTime >= COIN_COMPLETE_TIMEOUT) {
      portENTER_CRITICAL(&paymentMux);
      unsigned int coinValue = currentCoinPulses;
      currentCoinPulses = 0;
      portEXIT_CRITICAL(&paymentMux);
      totalCoinPesos += coinValue;
      totalPesos = totalCoinPesos + totalBillPesos;
      totalsDirty = true;
      if (isPaired && wsConnected) {
        String coinMsg = "{\"type\":\"coin-inserted\",\"deviceId\":\"" +
                         deviceId + "\",\"coinValue\":" + String(coinValue) +
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

  // CAM heartbeats and pairing retries
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
    relayClassificationErrorToBackend("CAM_RESPONSE_TIMEOUT");
  }

  if (Serial.available())
    handleSerialCommand(Serial.readStringUntil('\n'));
  if (softAPStarted)
    handleWiFiPortal();

  // WiFi state machine
  if (wifiConnected && WiFi.status() != WL_CONNECTED) {
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
    wifiServer.stop();
    WiFi.softAPdisconnect(true);

    LOG("[WIFI] Connected! Wait 3s for system stabilisation...");
    delay(3000);

    if (!isPaired)
      sendDeviceRegistration();

    LOG("[WS] Powering up connection...");
    webSocket.disconnect();
    wsInitialized = false;
    connectWebSocket();

    delay(500);
    sendPairingBroadcast();
  }

  if (!wifiConnected && !softAPStarted) {
    if (millis() - lastWiFiRetry >= WIFI_RETRY_INTERVAL) {
      lastWiFiRetry = millis();
      wl_status_t status = WiFi.status();
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
          if (ssid.length() > 0)
            WiFi.begin(ssid.c_str(), pass.c_str());
        }
      }
    }
  }

  if (!wifiConnected)
    return;

  // Status updates
  if (wsConnected && millis() - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
    lastStatusUpdate = millis();
    String statusMsg = "{\"type\":\"status-update\",\"deviceId\":\"" +
                       deviceId +
                       "\",\"camSynced\":" + (camIsReady ? "true" : "false") +
                       ",\"isPaired\":" + (isPaired ? "true" : "false") + "}";
    webSocket.sendTXT(statusMsg);
  }

  // Sensor updates
  if (wsConnected && !stepper1Moving && !stepper2Moving) {
    if (isPaired && millis() - lastDHTRead >= DHT_READ_INTERVAL) {
      lastDHTRead = millis();
      if (readDHT11())
        sendDHTDataViaWebSocket();
    }
    if (isPaired && millis() - lastUltrasonicRead >= ULTRASONIC_READ_INTERVAL) {
      lastUltrasonicRead = millis();
      bool s1 = readAtomizerLevel();
      bool s2 = readFoamLevel();
      if (s1 || s2)
        sendUltrasonicDataViaWebSocket();
    }
  }

  handleService();
  handleDryingTemperature();
  handlePurge();

  yield();
}
