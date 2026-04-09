#define FIRMWARE_VERSION "1.0.3"
#define BOARD_NAME "SSCM-CAM"

/*
 * SSCM CAM Modular Firmware — Gemini HTTP Edition
 */

#include "esp_camera.h"
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define LOG(msg) Serial.println(msg)

/* ===================== HARDWARE CONFIG ===================== */
#define CAMERA_MODEL_ESP32S3_EYE
#if defined(CAMERA_MODEL_ESP32S3_EYE)
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 15
#define SIOD_GPIO_NUM 4
#define SIOC_GPIO_NUM 5
#define Y2_GPIO_NUM 11
#define Y3_GPIO_NUM 9
#define Y4_GPIO_NUM 8
#define Y5_GPIO_NUM 10
#define Y6_GPIO_NUM 12
#define Y7_GPIO_NUM 18
#define Y8_GPIO_NUM 17
#define Y9_GPIO_NUM 16
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM 7
#define PCLK_GPIO_NUM 13
#endif

/* ===================== SHARED STRUCTS ===================== */

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
#define CAM_STATUS_BUSY 3
#define CAM_STATUS_NOT_READY 4
#define CAM_STATUS_API_HANDLED 6

/* ===================== GLOBAL STATE ===================== */
Preferences prefs;
String camOwnDeviceId = "";
uint8_t mainBoardMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
bool mainBoardPaired = false;
String storedGroupToken = "";

bool pairingAckPending = false;
unsigned long pairingTime = 0;
const unsigned long PAIRING_ACK_TIMEOUT_MS = 15000;

bool wifiConnected = false;
bool httpServerStarted = false;
unsigned long wifiConnectStartMs = 0;
String camIp = "";
volatile bool wifiReconnectRequested = false;

volatile bool classificationRequested = false;
bool classificationInProgress = false;
static portMUX_TYPE classMux = portMUX_INITIALIZER_UNLOCKED;

volatile bool factoryResetRequested = false;
static bool is_initialised = false;

WebServer httpServer(80);

static camera_config_t camera_config = {
    .pin_pwdn = PWDN_GPIO_NUM,
    .pin_reset = RESET_GPIO_NUM,
    .pin_xclk = XCLK_GPIO_NUM,
    .pin_sscb_sda = SIOD_GPIO_NUM,
    .pin_sscb_scl = SIOC_GPIO_NUM,
    .pin_d7 = Y9_GPIO_NUM,
    .pin_d6 = Y8_GPIO_NUM,
    .pin_d5 = Y7_GPIO_NUM,
    .pin_d4 = Y6_GPIO_NUM,
    .pin_d3 = Y5_GPIO_NUM,
    .pin_d2 = Y4_GPIO_NUM,
    .pin_d1 = Y3_GPIO_NUM,
    .pin_d0 = Y2_GPIO_NUM,
    .pin_vsync = VSYNC_GPIO_NUM,
    .pin_href = HREF_GPIO_NUM,
    .pin_pclk = PCLK_GPIO_NUM,
    .xclk_freq_hz = 20000000,
    .ledc_timer = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,
    .frame_size = FRAMESIZE_VGA,
    .jpeg_quality = 8,
    .fb_count = 1,
    .fb_location = CAMERA_FB_IN_PSRAM,
    .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
};

/* ===================== SETUP ===================== */
void setup() {
  Serial.begin(115200);
  delay(1000);
  LOG("\n\n===================================");
  LOG("  " + String(BOARD_NAME) + " v" + String(FIRMWARE_VERSION));
  LOG("===================================\n");

  prefs.begin("cam", false);
  camOwnDeviceId = generateCamOwnDeviceId();
  LOG("[BOOT] Device ID: " + camOwnDeviceId);

  // Restore Pairing
  size_t macLen = prefs.getBytes("mainMac", mainBoardMac, 6);
  if (macLen == 6 && mainBoardMac[0] != 0xFF) {
    mainBoardPaired = true;
    LOG("[BOOT] Paired Board MAC found");
  }

  storedGroupToken = prefs.getString("groupToken", "");

  // Factory reset via BOOT button (GPIO0) held at power-on for 3s
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
    LOG("[BOOT] BOOT button held, waiting for factory reset...");
    delay(3000);
    if (digitalRead(0) == LOW) {
      LOG("[BOOT] Factory reset triggered!");
      factoryReset();
    }
  }

  // WiFi Events
  WiFi.onEvent(onWiFiConnected, ARDUINO_EVENT_WIFI_STA_CONNECTED);
  WiFi.onEvent(onWiFiGotIP, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(onWiFiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA);
  delay(200);

  // ESP-NOW
  if (esp_now_init() == ESP_OK) {
    esp_now_register_send_cb(onDataSent);
    esp_now_register_recv_cb(onDataRecv);
    if (mainBoardPaired) addPeerIfNeeded(mainBoardMac);
    LOG("[BOOT] ESP-NOW initialized");
  }

  // Camera
  if (!camera_init()) LOG("[BOOT] Camera FAILED");

  // Initial Connect
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  if (ssid.length() > 0) {
    LOG("[BOOT] WiFi: connecting to " + ssid);
    WiFi.begin(ssid.c_str(), pass.c_str());
    wifiConnectStartMs = millis();
  }
}

/* ===================== LOOP ===================== */
void loop() {
  ArduinoOTA.handle();

  static bool otaInitialized = false;
  if (wifiConnected && !otaInitialized) {
    setupOTA();
    otaInitialized = true;
  }

  handleWiFiReconnect(); // Robust reconnect with cooldown

  if (wifiConnected && !httpServerStarted) setupHTTPServer();
  if (wifiConnected && httpServerStarted) httpServer.handleClient();

  // Send PairingAck
  if (pairingAckPending && (wifiConnected || (millis() - pairingTime > PAIRING_ACK_TIMEOUT_MS))) {
    if ((millis() - pairingTime > PAIRING_ACK_TIMEOUT_MS) && !wifiConnected) {
      LOG("[LOOP] PairingAck timeout: sending without IP");
    } else {
      LOG("[LOOP] WiFi ready: sending PairingAck with IP");
    }
    sendPairingAck(mainBoardMac);
    pairingAckPending = false;
  }

  if (factoryResetRequested) factoryReset();

  // Classification Pipeline
  portENTER_CRITICAL(&classMux);
  bool doClassify = classificationRequested && !classificationInProgress;
  if (doClassify) {
    classificationRequested = false;
    classificationInProgress = true;
  }
  portEXIT_CRITICAL(&classMux);

  if (doClassify) {
    captureAndPostToBackend();
    classificationInProgress = false;
  }

  // --- Serial commands (for parity with original) ---
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim(); cmd.toUpperCase();

    if (cmd == "CLASSIFY" || cmd == "TEST") {
       LOG("[CMD] Manual classification request");
       classificationRequested = true; 
    } else if (cmd == "STATUS") {
      LOG("[CMD] Camera: " + String(is_initialised ? "READY" : "NOT_INIT"));
      LOG("[CMD] WiFi: " + String(wifiConnected ? "CONNECTED" : "DISCONNECTED"));
      LOG("[CMD] Paired: " + String(mainBoardPaired ? "YES" : "NO"));
      LOG("[CMD] HTTP Server: " + String(httpServerStarted ? "RUNNING" : "STOPPED"));
    } else if (cmd == "UNPAIR") {
      LOG("[CMD] Unpairing from main board");
      prefs.remove("mainMac");
      prefs.remove("groupToken");
      prefs.remove("mainId");
      mainBoardPaired = false;
      storedGroupToken = "";
      memset(mainBoardMac, 0xFF, 6);
    } else if (cmd == "CLEAR") {
      LOG("[CMD] Clearing all preferences");
      prefs.clear();
    } else if (cmd == "FACTORY_RESET") {
      factoryReset();
    }
  }

  delay(5);
}
