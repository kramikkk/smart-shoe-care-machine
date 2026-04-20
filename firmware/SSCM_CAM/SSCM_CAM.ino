#define FIRMWARE_VERSION "1.0.13"
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
// Pin map for the ESP32-S3-EYE module (OV2640 sensor via SCCB/parallel bus).
#define CAMERA_MODEL_ESP32S3_EYE
#if defined(CAMERA_MODEL_ESP32S3_EYE)
#define PWDN_GPIO_NUM  -1   // Power-down: not wired on this module
#define RESET_GPIO_NUM -1   // Hardware reset: not wired on this module
#define XCLK_GPIO_NUM  15   // Master clock output to image sensor (~20 MHz)
#define SIOD_GPIO_NUM   4   // SCCB data line (I2C-compatible config bus)
#define SIOC_GPIO_NUM   5   // SCCB clock line
// Parallel 8-bit pixel data bus from sensor (Y2 = LSB, Y9 = MSB)
#define Y2_GPIO_NUM    11
#define Y3_GPIO_NUM     9
#define Y4_GPIO_NUM     8
#define Y5_GPIO_NUM    10
#define Y6_GPIO_NUM    12
#define Y7_GPIO_NUM    18
#define Y8_GPIO_NUM    17
#define Y9_GPIO_NUM    16
#define VSYNC_GPIO_NUM  6   // Frame sync pulse from sensor (high = new frame)
#define HREF_GPIO_NUM   7   // Horizontal line valid (high = pixel data on bus)
#define PCLK_GPIO_NUM  13   // Pixel clock — data on bus is valid on rising edge
#endif

/* ===================== SHARED STRUCTS ===================== */

// Broadcast packet sent by MAIN during discovery/pairing.
// CAM listens for this to learn WiFi credentials + backend endpoint.
typedef struct {
  uint8_t type;
  char groupToken[10];
  char deviceId[24];
  char ssid[32];
  char password[64];
  char wsHost[64];
  uint16_t wsPort;
} PairingBroadcast;

// ACK packet sent by CAM after accepting pairing.
// Returns CAM identity + current IP so MAIN can bind this specific unit.
typedef struct {
  uint8_t type;
  char camOwnDeviceId[24];
  char camIp[20];
} PairingAck;

// Runtime command/result envelope used for CAM<->MAIN control traffic.
typedef struct {
  uint8_t type;
  uint8_t status;
  char shoeType[32];
  float confidence;
} CamMessage;

// ESP-NOW message type field — identifies the purpose of each CamMessage packet.
#define CAM_MSG_PAIR_REQUEST    1  // MAIN → broadcast: initiate pairing, carries WiFi + backend info
#define CAM_MSG_PAIR_ACK        2  // CAM  → MAIN: accept pairing, carries CAM device ID + LAN IP
#define CAM_MSG_CLASSIFY_REQUEST 3 // MAIN → CAM: trigger image capture and Gemini classification
#define CAM_MSG_CLASSIFY_RESULT  4 // CAM  → MAIN: classification outcome (shoe type + confidence)
#define CAM_MSG_STATUS_PING     5  // MAIN → CAM: liveness check (expects PONG back)
#define CAM_MSG_STATUS_PONG     6  // CAM  → MAIN: liveness reply to a PING
#define CAM_MSG_LED_ENABLE      7  // MAIN → CAM: turn on the illumination LED
#define CAM_MSG_LED_DISABLE     8  // MAIN → CAM: turn off the illumination LED
#define CAM_MSG_FACTORY_RESET   9  // MAIN → CAM: wipe all stored credentials and reboot

// Status codes carried in the CamMessage.status field of CLASSIFY_RESULT packets.
#define CAM_STATUS_OK          0   // Classification succeeded; shoeType + confidence are valid
#define CAM_STATUS_ERROR       1   // Camera capture failed or HTTP POST to backend failed
#define CAM_STATUS_BUSY        3   // A classification is already in progress; request ignored
#define CAM_STATUS_NOT_READY   4   // Camera driver not yet initialised; cannot capture
#define CAM_STATUS_API_HANDLED 6   // Gemini path: backend received JPEG and will relay result itself

/* ===================== GLOBAL STATE ===================== */
Preferences prefs;                                  // NVS-backed persistent storage
String camOwnDeviceId = "";                         // Unique ID generated from MAC at boot
uint8_t mainBoardMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}; // Stored MAIN MAC; 0xFF = unpaired
bool mainBoardPaired = false;                       // True once a valid MAIN MAC is stored in NVS
String storedGroupToken = "";                       // Shared secret used to validate pairing origin

// Deferred pairing ACK — CAM waits for an IP before replying so MAIN gets a usable address.
// Falls back to sending without IP after PAIRING_ACK_TIMEOUT_MS if WiFi never connects.
bool pairingAckPending = false;
unsigned long pairingTime = 0;
const unsigned long PAIRING_ACK_TIMEOUT_MS = 15000; // Max wait (ms) for IP before sending ACK anyway

bool wifiConnected = false;
bool httpServerStarted = false;
unsigned long wifiConnectStartMs = 0; // Timestamp of the most recent WiFi.begin() call
String camIp = "";                    // Current LAN IP; sent to MAIN in PairingAck
volatile bool wifiReconnectRequested = false; // Set by disconnect event; consumed in loop()

// Classification request flag is set from the ESP-NOW callback (interrupt context)
// and consumed in loop() to keep camera capture + HTTP work off the radio callback stack.
// classificationInProgress is loop()-only, so it does NOT need to be volatile.
volatile bool classificationRequested = false;
bool classificationInProgress = false;
static portMUX_TYPE classMux = portMUX_INITIALIZER_UNLOCKED; // Guards the request/in-progress pair

volatile bool factoryResetRequested = false; // Set from serial or ESP-NOW; executed in loop()
static bool is_initialised = false;          // Camera driver init state (mirrors driver internal flag)

WebServer httpServer(80);

static camera_config_t camera_config = {
    .pin_pwdn    = PWDN_GPIO_NUM,
    .pin_reset   = RESET_GPIO_NUM,
    .pin_xclk    = XCLK_GPIO_NUM,
    .pin_sscb_sda = SIOD_GPIO_NUM,
    .pin_sscb_scl = SIOC_GPIO_NUM,
    // Pixel data pins: d7 = MSB (Y9), d0 = LSB (Y2)
    .pin_d7 = Y9_GPIO_NUM,
    .pin_d6 = Y8_GPIO_NUM,
    .pin_d5 = Y7_GPIO_NUM,
    .pin_d4 = Y6_GPIO_NUM,
    .pin_d3 = Y5_GPIO_NUM,
    .pin_d2 = Y4_GPIO_NUM,
    .pin_d1 = Y3_GPIO_NUM,
    .pin_d0 = Y2_GPIO_NUM,
    .pin_vsync = VSYNC_GPIO_NUM,
    .pin_href  = HREF_GPIO_NUM,
    .pin_pclk  = PCLK_GPIO_NUM,
    .xclk_freq_hz = 20000000,    // 20 MHz sensor clock (OV2640 max reliable rate)
    .ledc_timer   = LEDC_TIMER_0,
    .ledc_channel = LEDC_CHANNEL_0,
    .pixel_format = PIXFORMAT_JPEG,    // Capture direct to JPEG; no raw decode needed
    .frame_size   = FRAMESIZE_VGA,     // 640×480 — enough detail for Gemini, fits in PSRAM
    .jpeg_quality = 8,                 // OV2640 scale: 0 = best, 63 = worst; 8 = high quality
    .fb_count     = 1,                 // Single framebuffer (PSRAM); two would allow double-buffering
    .fb_location  = CAMERA_FB_IN_PSRAM,
    .grab_mode    = CAMERA_GRAB_WHEN_EMPTY, // Capture when buffer is free (not GRAB_LATEST); avoids stale frames
};

/* ===================== SETUP ===================== */
// Boot sequence:
// 1) restore persisted pairing/WiFi state
// 2) initialize radio + camera stack
// 3) attempt WiFi join when credentials exist
void setup() {
  Serial.begin(115200);
  delay(1000);
  LOG("\n\n===================================");
  LOG("  " + String(BOARD_NAME) + " v" + String(FIRMWARE_VERSION));
  LOG("===================================\n");

  prefs.begin("cam", false);
  camOwnDeviceId = generateCamOwnDeviceId();
  LOG("[BOOT] Device ID: " + camOwnDeviceId);

  // Restore previously paired MAIN MAC to support auto-reconnect after reboot.
  size_t macLen = prefs.getBytes("mainMac", mainBoardMac, 6);
  if (macLen == 6 && mainBoardMac[0] != 0xFF) {
    mainBoardPaired = true;
    LOG("[BOOT] Paired Board MAC found");
  }

  storedGroupToken = prefs.getString("groupToken", "");

  // Local recovery path: hold BOOT at startup to clear provisioning.
  pinMode(0, INPUT_PULLUP);
  if (digitalRead(0) == LOW) {
    LOG("[BOOT] BOOT button held, waiting for factory reset...");
    delay(3000);
    if (digitalRead(0) == LOW) {
      LOG("[BOOT] Factory reset triggered!");
      factoryReset();
    }
  }

  // Register WiFi event callbacks (non-blocking state machine).
  WiFi.onEvent(onWiFiConnected, ARDUINO_EVENT_WIFI_STA_CONNECTED);
  WiFi.onEvent(onWiFiGotIP, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(onWiFiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  esp_wifi_set_ps(WIFI_PS_NONE);  // Disable WiFi power saving (no sleep mode)
  delay(200);

  // Bring up ESP-NOW side-channel for low-latency command/control with MAIN.
  if (esp_now_init() == ESP_OK) {
    esp_now_register_send_cb(onDataSent);
    esp_now_register_recv_cb(onDataRecv);
    if (mainBoardPaired) addPeerIfNeeded(mainBoardMac);
    LOG("[BOOT] ESP-NOW initialized");
  }

  // Camera must be ready before classification requests are accepted.
  if (!camera_init()) LOG("[BOOT] Camera FAILED");

  // Join stored WiFi if already provisioned by pairing flow.
  // Direct WiFi.begin() is intentional here — this is a one-time boot call,
  // so the reconnect gap guard in handleWiFiReconnect() does not apply.
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  if (ssid.length() > 0) {
    LOG("[BOOT] WiFi: connecting to " + ssid);
    WiFi.begin(ssid.c_str(), pass.c_str());
    wifiConnectStartMs = millis();
  }
}

/* ===================== LOOP ===================== */
// Main runtime loop keeps OTA/network/control responsive and never blocks long.
void loop() {
  ArduinoOTA.handle();

  static bool otaInitialized = false;
  if (wifiConnected && !otaInitialized) {
    setupOTA();
    otaInitialized = true;
  }

  // Retry strategy prevents tight reconnect loops when AP is unavailable.
  handleWiFiReconnect(); // Robust reconnect with cooldown

  if (wifiConnected && !httpServerStarted) setupHTTPServer();
  if (wifiConnected && httpServerStarted) httpServer.handleClient();

  // Pairing ACK is deferred until IP is available (or timeout fallback).
  // This lets MAIN store both MAC + current CAM IP for diagnostics/HTTP checks.
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

  // Classification trigger is latched from ISR/ESP-NOW context and consumed here
  // in the main loop to keep camera + HTTP work out of critical/interrupt paths.
  // classMux protects request/in-progress flags against concurrent access.
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

  // Serial commands provide an offline maintenance/debug interface.
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
