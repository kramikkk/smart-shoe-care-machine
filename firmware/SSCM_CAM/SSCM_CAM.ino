// Set to 0 to disable Serial logging in production builds
#define SSCM_DEBUG 1

#define FIRMWARE_VERSION "1.0.1"
#define BOARD_NAME "SSCM-CAM"

/*
 * SSCM CAM Firmware — Gemini HTTP Classification Edition
 *
 * Replaces Edge Impulse local inference with HTTP POST to backend.
 * CAM captures a JPEG and POSTs it to /api/device/[mainId]/classify.
 * Backend calls Gemini and broadcasts the result via WebSocket.
 * CAM ACKs the main board with CAM_STATUS_API_HANDLED (6) via ESP-NOW.
 */

#include "esp_camera.h"
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// Select camera model
#define CAMERA_MODEL_ESP32S3_EYE // Has PSRAM

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
#else
#error "Camera model not selected"
#endif

/* ===================== SHARED ESP-NOW DEFINITIONS ===================== */
// These structs MUST match Thesis_SSCM.ino exactly.

// Pairing broadcast from main board to CAM
typedef struct {
  uint8_t type;        // CAM_MSG_PAIR_REQUEST = 1
  char groupToken[10]; // 8 hex chars + null terminator
  char deviceId[24];   // Main board device ID (e.g., SSCM-ABC123)
  char ssid[32];       // WiFi SSID for CAM to connect (streaming)
  char password[64];   // WiFi password
  char wsHost[64];     // Backend host
  uint16_t wsPort;     // Backend port
} PairingBroadcast;    // ~197 bytes — within 250-byte ESP-NOW limit

// Pairing acknowledgment from CAM to main board
typedef struct {
  uint8_t type;            // CAM_MSG_PAIR_ACK = 2
  char camOwnDeviceId[24]; // e.g., SSCM-CAM-D4DB1C
  char camIp[20];          // CAM's WiFi IP (empty string if not connected yet)
} PairingAck;              // 45 bytes

// Runtime classification/control message (bidirectional)
typedef struct {
  uint8_t type;      // Message type constant
  uint8_t status;    // Status code constant
  char shoeType[32]; // unused in Gemini path
  float confidence;  // unused in Gemini path
} CamMessage;        // 38 bytes — well within 250-byte limit

// Message type constants
#define CAM_MSG_PAIR_REQUEST 1     // Main board → CAM: pairing broadcast
#define CAM_MSG_PAIR_ACK 2         // CAM → Main board: pairing accepted
#define CAM_MSG_CLASSIFY_REQUEST 3 // Main board → CAM: run classifier
#define CAM_MSG_CLASSIFY_RESULT 4  // CAM → Main board: classifier output
#define CAM_MSG_STATUS_PING 5      // Main board → CAM: are you ready?
#define CAM_MSG_STATUS_PONG 6      // CAM → Main board: yes/no
#define CAM_MSG_LED_ENABLE 7       // Main board → CAM: classification light on
#define CAM_MSG_LED_DISABLE 8      // Main board → CAM: classification light off
#define CAM_MSG_FACTORY_RESET 9 // Main board → CAM: wipe all prefs and restart

// Status codes in CamMessage.status
#define CAM_STATUS_OK 0
#define CAM_STATUS_ERROR 1
#define CAM_STATUS_TIMEOUT 2
#define CAM_STATUS_BUSY 3
#define CAM_STATUS_NOT_READY 4
#define CAM_STATUS_LOW_CONFIDENCE 5
#define CAM_STATUS_API_HANDLED                                                 \
  6 // Gemini path — backend handles result broadcast

/* ===================== PREFERENCES ===================== */
Preferences prefs;

/* ===================== CAM IDENTITY ===================== */
String camOwnDeviceId = "";

/* ===================== ESP-NOW STATE ===================== */
uint8_t mainBoardMac[6] = {0xFF, 0xFF, 0xFF,
                           0xFF, 0xFF, 0xFF}; // broadcast until paired
bool mainBoardPaired = false;
String storedGroupToken = "";

/* ===================== PAIRING STATE ===================== */
bool pairingAckPending = false;
unsigned long pairingTime = 0;
const unsigned long PAIRING_ACK_TIMEOUT_MS = 15000;

/* ===================== WIFI STATE ===================== */
bool wifiConnected = false;
bool httpServerStarted = false;
unsigned long wifiConnectStartMs = 0;
String camIp = "";
volatile bool wifiReconnectRequested = false;

/* ===================== CLASSIFICATION STATE ===================== */
volatile bool classificationRequested = false;
bool classificationInProgress = false;
static portMUX_TYPE classMux = portMUX_INITIALIZER_UNLOCKED;

/* ===================== FACTORY RESET STATE ===================== */
volatile bool factoryResetRequested = false;

/* ===================== CAMERA INIT STATE ===================== */
static bool is_initialised = false;

/* ===================== HTTP SERVER ===================== */
WebServer httpServer(80);
#define PART_BOUNDARY "frameboundary"

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
    .frame_size = FRAMESIZE_VGA, // 640x480 — fits in one Gemini image tile (258
                                 // tokens); XGA used 2 tiles; sufficient for
                                 // material classification

    .jpeg_quality =
        8, // slightly lower quality than 6 to offset VGA's smaller canvas;
    .fb_count = 1,
    .fb_location = CAMERA_FB_IN_PSRAM,
    .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
};

/* ===================== CAM DEVICE ID ===================== */
String generateCamOwnDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[24];
  snprintf(id, sizeof(id), "SSCM-CAM-%02X%02X%02X", (uint8_t)(chipid >> 16),
           (uint8_t)(chipid >> 8), (uint8_t)chipid);
  return String(id);
}

/* ===================== ESP-NOW HELPERS ===================== */

void addPeerIfNeeded(uint8_t *mac) {
  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0;
    peer.encrypt = false;
    esp_now_add_peer(&peer);
  }
}

// Send CamMessage to the paired main board
void sendCamMessage(uint8_t type, uint8_t status, const char *shoeType,
                    float confidence) {
  if (!mainBoardPaired)
    return;

  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = type;
  msg.status = status;
  msg.confidence = confidence;
  if (shoeType)
    strncpy(msg.shoeType, shoeType, sizeof(msg.shoeType) - 1);

  addPeerIfNeeded(mainBoardMac);
  esp_now_send(mainBoardMac, (uint8_t *)&msg, sizeof(msg));
}

// Send PairingAck to the main board that paired us
void sendPairingAck(uint8_t *targetMac) {
  PairingAck ack;
  memset(&ack, 0, sizeof(ack));
  ack.type = CAM_MSG_PAIR_ACK;
  strncpy(ack.camOwnDeviceId, camOwnDeviceId.c_str(),
          sizeof(ack.camOwnDeviceId) - 1);
  if (camIp.length() > 0) {
    strncpy(ack.camIp, camIp.c_str(), sizeof(ack.camIp) - 1);
  }

  addPeerIfNeeded(targetMac);
  esp_err_t res = esp_now_send(targetMac, (uint8_t *)&ack, sizeof(ack));

#if SSCM_DEBUG
  Serial.println("[ESP-NOW] Sent PairingAck (" +
                 String(res == ESP_OK ? "OK" : "FAIL") + ")");
  if (camIp.length() > 0) {
    Serial.println("[ESP-NOW] Reported CAM IP: " + camIp);
  } else {
    Serial.println(
        "[ESP-NOW] WiFi not connected yet — IP will be sent when connected");
  }
#endif
}

/* ===================== ESP-NOW SEND CALLBACK ===================== */
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Send failed");
#endif
  }
}

/* ===================== ESP-NOW RECEIVE CALLBACK ===================== */
// IMPORTANT: This runs in the WiFi task. Keep it lightweight — only set flags,
// send short responses. Never run classification from here.
void onDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data,
                int len) {
  if (len < 1)
    return;

  uint8_t msgType = data[0];
  uint8_t *senderMac = recv_info->src_addr;

  // ============================================================
  // PAIRING REQUEST (type 1): Accept first valid groupToken broadcast
  // ============================================================
  if (msgType == CAM_MSG_PAIR_REQUEST) {
    if (len < (int)sizeof(PairingBroadcast)) {
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] PairingBroadcast too small: " + String(len));
#endif
      return;
    }

    PairingBroadcast pb;
    memcpy(&pb, data, sizeof(PairingBroadcast));

#if SSCM_DEBUG
    Serial.println("\n[ESP-NOW] Pairing request from: " + String(pb.deviceId));
#endif

    if (mainBoardPaired) {
      bool sameBoard = (memcmp(senderMac, mainBoardMac, 6) == 0);
      if (!sameBoard) {
#if SSCM_DEBUG
        Serial.println("[ESP-NOW] Already paired to different board — ignored");
#endif
        return;
      }
#if SSCM_DEBUG
      Serial.println(
          "[ESP-NOW] Re-pair from known board — updating credentials");
#endif
    }

    pb.groupToken[sizeof(pb.groupToken) - 1] = '\0';
    String token = String(pb.groupToken);
    token.toUpperCase();
    if (token.length() != 8) {
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] Invalid groupToken length: '" + token + "'");
#endif
      return;
    }
    bool tokenValid = true;
    for (int i = 0; i < 8; i++) {
      char c = token[i];
      if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) {
        tokenValid = false;
        break;
      }
    }
    if (!tokenValid) {
#if SSCM_DEBUG
      Serial.println("[ESP-NOW] Invalid groupToken chars: '" + token + "'");
#endif
      return;
    }

    prefs.putString("ssid", String(pb.ssid));
    prefs.putString("pass", String(pb.password));
    prefs.putString("wsHost", String(pb.wsHost));
    prefs.putUInt("wsPort", pb.wsPort);
    prefs.putString("groupToken", token);
    prefs.putString("mainId", String(pb.deviceId));

    storedGroupToken = token;

    memcpy(mainBoardMac, senderMac, 6);
    prefs.putBytes("mainMac", mainBoardMac, 6);
    mainBoardPaired = true;

#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Paired with main board: " + String(pb.deviceId));
    Serial.println("[ESP-NOW] GroupToken: " + storedGroupToken);
    Serial.printf("[ESP-NOW] Main board MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
                  mainBoardMac[0], mainBoardMac[1], mainBoardMac[2],
                  mainBoardMac[3], mainBoardMac[4], mainBoardMac[5]);
#endif

    String ssid = String(pb.ssid);
    String pass = String(pb.password);
    if (ssid.length() > 0) {
      WiFi.begin(ssid.c_str(), pass.c_str());
      wifiConnectStartMs = millis();
#if SSCM_DEBUG
      Serial.println("[WiFi] Connecting to: " + ssid);
#endif
    }

    pairingAckPending = true;
    pairingTime = millis();

    return;
  }

  // ============================================================
  // RUNTIME MESSAGES: Must come from the paired main board
  // ============================================================
  if (!mainBoardPaired) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Not paired — ignoring runtime message type " +
                   String(msgType));
#endif
    return;
  }

  if (memcmp(senderMac, mainBoardMac, 6) != 0) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Message from unknown MAC — ignored");
#endif
    return;
  }

  if (len < (int)sizeof(CamMessage)) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] CamMessage too small: " + String(len));
#endif
    return;
  }

  CamMessage msg;
  memcpy(&msg, data, sizeof(CamMessage));

  switch (msg.type) {

  case CAM_MSG_CLASSIFY_REQUEST:
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] CLASSIFY_REQUEST received");
#endif
    if (!is_initialised) {
      sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
    } else if (classificationInProgress) {
      sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_BUSY, "", 0.0f);
    } else {
      classificationRequested = true;
    }
    break;

  case CAM_MSG_STATUS_PING:
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] STATUS_PING received");
#endif
    sendCamMessage(CAM_MSG_STATUS_PONG,
                   is_initialised ? CAM_STATUS_OK : CAM_STATUS_NOT_READY, "",
                   0.0f);
    break;

  case CAM_MSG_LED_ENABLE:
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] LED_ENABLE (classification lighting)");
#endif
    break;

  case CAM_MSG_LED_DISABLE:
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] LED_DISABLE");
#endif
    break;

  case CAM_MSG_FACTORY_RESET:
#if SSCM_DEBUG
    Serial.println(
        "[ESP-NOW] FACTORY_RESET received — will reset after callback");
#endif
    factoryResetRequested = true;
    break;

  default:
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Unknown message type: " + String(msg.type));
#endif
    break;
  }
}

/* ===================== HTTP STREAM SERVER ===================== */

void handleStream() {
  WiFiClient client = httpServer.client();

  client.print("HTTP/1.1 200 OK\r\n");
  client.print(
      "Content-Type: multipart/x-mixed-replace; boundary=" PART_BOUNDARY
      "\r\n");
  client.print("Cache-Control: no-cache\r\n");
  client.print("Connection: keep-alive\r\n\r\n");

#if SSCM_DEBUG
  Serial.println("[Stream] Client connected");
#endif
  int frameCount = 0;

  while (client.connected()) {
    yield();

    if (classificationRequested) {
#if SSCM_DEBUG
      Serial.println("[Stream] Classification requested — ending stream");
#endif
      break;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      delay(100);
      continue;
    }

    client.print("\r\n--" PART_BOUNDARY "\r\n");
    client.print("Content-Type: image/jpeg\r\n");
    client.printf("Content-Length: %u\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);

    esp_camera_fb_return(fb);
    frameCount++;

    delay(50); // ~20 FPS max
  }

#if SSCM_DEBUG
  Serial.println("[Stream] Client disconnected after " + String(frameCount) +
                 " frames");
#endif
}

void handleSnapshot() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    httpServer.send(500, "text/plain", "Camera capture failed");
    return;
  }

  size_t frameLen = fb->len; // save before fb_return
  httpServer.sendHeader("Content-Type", "image/jpeg");
  httpServer.sendHeader("Content-Length", String(frameLen));
  httpServer.sendHeader("Cache-Control", "no-cache");
  httpServer.send_P(200, "image/jpeg", (const char *)fb->buf, frameLen);

  esp_camera_fb_return(fb);
#if SSCM_DEBUG
  Serial.println("[Snapshot] Served " + String(frameLen) + " bytes");
#endif
}

void handleRoot() {
  String page = "<!DOCTYPE html><html><body>";
  page += "<h2>SSCM CAM — " + camOwnDeviceId + "</h2>";
  page += "<p>WiFi IP: " +
          (wifiConnected ? WiFi.localIP().toString() : "not connected") +
          "</p>";
  page += "<p>Camera: " + String(is_initialised ? "Ready" : "Not initialized") +
          "</p>";
  page += "<p>Paired to: " +
          (mainBoardPaired ? prefs.getString("mainId", "?") : "Not paired") +
          "</p>";
  page += "<p><a href=\"/stream\">Live Stream</a></p>";
  page += "<p><a href=\"/snapshot\">Snapshot</a></p>";
  page += "</body></html>";
  httpServer.send(200, "text/html", page);
}

void setupHTTPServer() {
  httpServer.on("/", HTTP_GET, handleRoot);
  httpServer.on("/stream", HTTP_GET, handleStream);
  httpServer.on("/snapshot", HTTP_GET, handleSnapshot);
  httpServer.begin();
  httpServerStarted = true;
  camIp = WiFi.localIP().toString();
#if SSCM_DEBUG
  Serial.println("[HTTP] Server started at: http://" + camIp);
#endif
}

/* ===================== WIFI EVENT HANDLERS ===================== */

void onWiFiConnected(WiFiEvent_t event, WiFiEventInfo_t info) {
#if SSCM_DEBUG
  Serial.println("[WiFi] Connected to AP");
#endif
}

void onWiFiGotIP(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = true;
  camIp = WiFi.localIP().toString();
#if SSCM_DEBUG
  Serial.println("[WiFi] Got IP: " + camIp);
#endif
}

void onWiFiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = false;
  httpServerStarted = false;
  camIp = "";
  wifiReconnectRequested = true;
#if SSCM_DEBUG
  Serial.println("[WiFi] Disconnected — reconnect requested from loop...");
#endif
}

/* ===================== CLASSIFICATION — Gemini HTTP path =====================
 */

void captureAndPostToBackend() {
#if SSCM_DEBUG
  Serial.println("\n=== Capturing JPEG for Gemini classification ===");
#endif

  if (!is_initialised) {
#if SSCM_DEBUG
    Serial.println("[Classify] Camera not initialized");
#endif
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
    return;
  }

  // Drain all buffered frames (fb_count=2) so we capture a truly fresh frame
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale)
      esp_camera_fb_return(stale);
  }
  delay(500); // Let AEC settle — extra time needed with bright LED strip in
              // chamber

  // Capture the actual frame
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
#if SSCM_DEBUG
    Serial.println("[Classify] Camera capture failed");
#endif
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

#if SSCM_DEBUG
  Serial.printf("[Classify] Captured %u bytes\n", fb->len);
#endif

  // Read backend connection info from prefs
  String wsHost = prefs.getString("wsHost", "");
  uint16_t wsPort = prefs.getUInt("wsPort", 3000);
  String mainId = prefs.getString("mainId", "");
  String token = storedGroupToken;

  if (wsHost.isEmpty() || mainId.isEmpty() || token.isEmpty()) {
#if SSCM_DEBUG
    Serial.println(
        "[Classify] Missing prefs (wsHost/mainId/groupToken) — not paired?");
#endif
    esp_camera_fb_return(fb);
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  String url = "http://" + wsHost + ":" + String(wsPort) + "/api/device/" +
               mainId + "/classify";
#if SSCM_DEBUG
  Serial.println("[Classify] POST → " + url);
#endif

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Group-Token", token);
  http.setTimeout(20000); // 20s — Gemini can be slow on free tier

  int httpCode = http.sendRequest("POST", fb->buf, fb->len);
  esp_camera_fb_return(fb); // Free buffer immediately after POST

#if SSCM_DEBUG
  if (httpCode > 0) {
    Serial.printf("[Classify] HTTP %d\n", httpCode);
  } else {
    Serial.println("[Classify] HTTP request failed: " +
                   http.errorToString(httpCode));
  }
#endif

  http.end();

  // ACK the main board: API_HANDLED only on HTTP 2xx, ERROR otherwise
  if (httpCode >= 200 && httpCode < 300) {
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_API_HANDLED, "", 0.0f);
#if SSCM_DEBUG
    Serial.println(
        "=== Classification POST complete — backend handles result ===\n");
#endif
  } else {
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
#if SSCM_DEBUG
    Serial.println(
        "=== Classification POST FAILED — sent ERROR ACK to main board ===\n");
#endif
  }
}

/* ===================== FACTORY RESET ===================== */
void factoryReset() {
#if SSCM_DEBUG
  Serial.println("[FactoryReset] Clearing all preferences...");
#endif
  prefs.clear();
#if SSCM_DEBUG
  Serial.println("[FactoryReset] Done. Restarting...");
#endif
  delay(500);
  ESP.restart();
}

/* ===================== CAMERA INIT ===================== */

bool camera_init(void) {
  if (is_initialised)
    return true;

  esp_err_t err = esp_camera_init(&camera_config);
  if (err != ESP_OK) {
#if SSCM_DEBUG
    Serial.printf("Camera init failed with error 0x%x\n", err);
#endif
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
#if SSCM_DEBUG
  Serial.printf("[Camera] Sensor PID: 0x%04X\n", s->id.PID);
#endif

  // OV5640 — 5MP sensor on Aideepen ESP32-S3-CAM
  if (s->id.PID == OV5640_PID) {
#if SSCM_DEBUG
    Serial.println("[Camera] OV5640 detected");
#endif
    s->set_vflip(s, 1); // Flip vertically (camera mounted upside down)
    s->set_hmirror(s, 0);

    // Auto exposure — slight compensation for bright LED strip
    s->set_exposure_ctrl(s, 1); // Auto exposure ON
    s->set_aec2(s, 0);          // Disable night-mode AEC
    s->set_ae_level(s, 0);      // Neutral AEC target (0 = no compensation)
    s->set_gain_ctrl(s, 1);     // Auto gain ON
    s->set_gainceiling(s, GAINCEILING_4X);

    // White balance
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_wb_mode(s, 0); // Auto WB

    // Image quality — balanced, not aggressive
    s->set_brightness(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1); // Lens correction
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
    s->set_raw_gma(s, 1);
  }
  // OV3660 fallback
  else if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 0);
    s->set_ae_level(s, -1);
    s->set_aec2(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1);
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
  }
  // Generic OV2640 or unknown fallback
  else {
    s->set_vflip(s, 1);
    s->set_brightness(s, 0);
    s->set_ae_level(s, -1);
    s->set_aec2(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1);
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
  }

  is_initialised = true;
  return true;
}

/* ===================== OTA ===================== */

void setupOTA() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char hostname[24];
  snprintf(hostname, sizeof(hostname), "sscm-cam-%02X%02X", mac[4], mac[5]);
  ArduinoOTA.setHostname(hostname);
  // Use stored group token as OTA password after pairing
  String token = prefs.getString("groupToken", "");
  if (token.length() == 8) {
    ArduinoOTA.setPassword(token.c_str());
  } else {
    // Derive fallback from MAC so each device has a unique password
    char fallback[9];
    snprintf(fallback, sizeof(fallback), "%02X%02X%02X%02X", mac[2], mac[3],
             mac[4], mac[5]);
    ArduinoOTA.setPassword(fallback);
  }
  ArduinoOTA.onStart([]() {
#if SSCM_DEBUG
    Serial.println("[OTA] Starting...");
#endif
  });
  ArduinoOTA.onEnd([]() {
#if SSCM_DEBUG
    Serial.println("[OTA] Done.");
#endif
  });
  ArduinoOTA.onError([](ota_error_t error) {
#if SSCM_DEBUG
    Serial.printf("[OTA] Error [%u]\n", error);
#endif
  });
  ArduinoOTA.begin();
#if SSCM_DEBUG
  Serial.println("[OTA] Ready. Hostname: " + String(hostname));
#endif
}

/* ===================== SETUP ===================== */

void setup() {
  Serial.begin(115200);
  delay(1000);

#if SSCM_DEBUG
  Serial.println("\n=================================");
  Serial.printf("  %s\n", BOARD_NAME);
  Serial.printf("  Firmware v%s\n", FIRMWARE_VERSION);
  Serial.println("=================================\n");
#endif

  prefs.begin("cam", false);

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

  camOwnDeviceId = generateCamOwnDeviceId();
#if SSCM_DEBUG
  Serial.println("[Startup] CAM Device ID: " + camOwnDeviceId);
#endif

  size_t macLen = prefs.getBytes("mainMac", mainBoardMac, 6);
  bool macValid = (macLen == 6 &&
                   !(mainBoardMac[0] == 0x00 && mainBoardMac[1] == 0x00 &&
                     mainBoardMac[2] == 0x00 && mainBoardMac[3] == 0x00 &&
                     mainBoardMac[4] == 0x00 && mainBoardMac[5] == 0x00) &&
                   !(mainBoardMac[0] == 0xFF && mainBoardMac[1] == 0xFF &&
                     mainBoardMac[2] == 0xFF && mainBoardMac[3] == 0xFF &&
                     mainBoardMac[4] == 0xFF && mainBoardMac[5] == 0xFF));

  if (macValid) {
    mainBoardPaired = true;
#if SSCM_DEBUG
    Serial.printf(
        "[Startup] Paired to main board MAC: %02X:%02X:%02X:%02X:%02X:%02X\n",
        mainBoardMac[0], mainBoardMac[1], mainBoardMac[2], mainBoardMac[3],
        mainBoardMac[4], mainBoardMac[5]);
#endif
  } else {
    memset(mainBoardMac, 0xFF, 6); // broadcast
#if SSCM_DEBUG
    Serial.println(
        "[Startup] Not paired — waiting for main board pairing broadcast");
#endif
  }

  storedGroupToken = prefs.getString("groupToken", "");
  if (storedGroupToken.length() > 0) {
#if SSCM_DEBUG
    Serial.println("[Startup] GroupToken: " + storedGroupToken);
#endif
  }

  WiFi.onEvent(onWiFiConnected, ARDUINO_EVENT_WIFI_STA_CONNECTED);
  WiFi.onEvent(onWiFiGotIP, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(onWiFiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  WiFi.mode(WIFI_STA);
  delay(200);
#if SSCM_DEBUG
  Serial.println("[WiFi] Mode: STA | MAC: " + WiFi.macAddress());
#endif

  if (esp_now_init() != ESP_OK) {
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Init FAILED!");
#endif
  } else {
    esp_now_register_send_cb(onDataSent);
    esp_now_register_recv_cb(onDataRecv);
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Initialized — listening for pairing broadcast");
#endif
  }

  if (mainBoardPaired) {
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, mainBoardMac, 6);
    peer.channel = 0;
    peer.encrypt = false;
    esp_now_add_peer(&peer);
#if SSCM_DEBUG
    Serial.println("[ESP-NOW] Added main board as peer");
#endif
  }

  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  if (ssid.length() > 0) {
    WiFi.begin(ssid.c_str(), pass.c_str());
    wifiConnectStartMs = millis();
#if SSCM_DEBUG
    Serial.println("[WiFi] Connecting to: " + ssid);
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[WiFi] No credentials — waiting for pairing broadcast");
#endif
  }

  if (!camera_init()) {
#if SSCM_DEBUG
    Serial.println("[Camera] Init FAILED");
#endif
  } else {
#if SSCM_DEBUG
    Serial.println("[Camera] Initialized");
#endif
  }

#if SSCM_DEBUG
  Serial.println("\n--- Serial Commands ---");
  Serial.println("CLASSIFY      - Capture and POST to backend (Gemini)");
  Serial.println("STATUS        - Show device status");
  Serial.println("UNPAIR        - Clear MAC pairing and groupToken");
  Serial.println("CLEAR         - Clear all stored data (restart required)");
  Serial.println("FACTORY_RESET - Wipe all prefs and restart");
  Serial.println("-----------------------\n");
#endif
}

/* ===================== LOOP ===================== */

void loop() {
  ArduinoOTA.handle();

  // --- Initialize OTA once WiFi is connected ---
  static bool otaInitialized = false;
  if (WiFi.status() == WL_CONNECTED && !otaInitialized) {
    setupOTA();
    otaInitialized = true;
  }

  // --- WiFi reconnect (deferred from event handler to avoid calling
  // WiFi.begin() in ISR context) ---
  if (wifiReconnectRequested) {
    wifiReconnectRequested = false;
    String ssid = prefs.getString("ssid", "");
    String pass = prefs.getString("pass", "");
    if (ssid.length() > 0) {
      WiFi.begin(ssid.c_str(), pass.c_str());
      wifiConnectStartMs = millis();
#if SSCM_DEBUG
      Serial.println("[WiFi] Reconnecting to: " + ssid);
#endif
    }
  }

  // --- HTTP server ---
  if (wifiConnected && httpServerStarted) {
    httpServer.handleClient();
  }

  // --- Start HTTP server when WiFi first connects ---
  if (wifiConnected && !httpServerStarted) {
    setupHTTPServer();
  }

  // --- Send pending PairingAck ---
  if (pairingAckPending) {
    bool wifiReady = wifiConnected && camIp.length() > 0;
    bool timedOut = (millis() - pairingTime) >= PAIRING_ACK_TIMEOUT_MS;

    if (wifiReady || timedOut) {
      if (timedOut && !wifiReady) {
#if SSCM_DEBUG
        Serial.println("[Pairing] WiFi timeout — sending ack without IP");
#endif
      }
      sendPairingAck(mainBoardMac);
      pairingAckPending = false;
    }
  }

  // --- Factory reset ---
  if (factoryResetRequested) {
    factoryResetRequested = false;
    factoryReset();
  }

  // --- Classification (runs from Arduino task, not ESP-NOW callback) ---
  // Atomic check-and-clear: classificationRequested can be set from WiFi task
  // (Core 0)
  portENTER_CRITICAL(&classMux);
  bool doClassify = classificationRequested && !classificationInProgress;
  if (doClassify) {
    classificationRequested = false;
    classificationInProgress = true;
  }
  portEXIT_CRITICAL(&classMux);
  if (doClassify) {
    captureAndPostToBackend();
    portENTER_CRITICAL(&classMux);
    classificationInProgress = false;
    portEXIT_CRITICAL(&classMux);
  }

  // --- Serial commands ---
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "CLASSIFY" || cmd == "TEST") {
      if (!is_initialised) {
#if SSCM_DEBUG
        Serial.println("[Classify] Camera not initialized");
#endif
      } else if (classificationInProgress) {
#if SSCM_DEBUG
        Serial.println("[Classify] Already in progress");
#endif
      } else {
        classificationInProgress = true;
        captureAndPostToBackend();
        classificationInProgress = false;
      }
    } else if (cmd == "STATUS") {
#if SSCM_DEBUG
      Serial.println("\n=== CAM Status ===");
      Serial.println("Device ID:   " + camOwnDeviceId);
      Serial.println("Camera:      " +
                     String(is_initialised ? "Ready" : "Not initialized"));
      Serial.println("WiFi:        " +
                     String(wifiConnected ? camIp : "Disconnected"));
      Serial.println("HTTP Server: " + String(httpServerStarted
                                                  ? "Running at http://" + camIp
                                                  : "Stopped"));
      Serial.println("GroupToken:  " + (storedGroupToken.length() > 0
                                            ? storedGroupToken
                                            : "none"));
      Serial.println("Paired:      " + String(mainBoardPaired ? "YES" : "NO"));
      if (mainBoardPaired) {
        Serial.printf("Main MAC:    %02X:%02X:%02X:%02X:%02X:%02X\n",
                      mainBoardMac[0], mainBoardMac[1], mainBoardMac[2],
                      mainBoardMac[3], mainBoardMac[4], mainBoardMac[5]);
        Serial.println("Main ID:     " + prefs.getString("mainId", "?"));
      }
      Serial.println("==================\n");
#endif
    } else if (cmd == "UNPAIR") {
      prefs.remove("mainMac");
      prefs.remove("groupToken");
      prefs.remove("mainId");
      mainBoardPaired = false;
      storedGroupToken = "";
      memset(mainBoardMac, 0xFF, 6);
#if SSCM_DEBUG
      Serial.println(
          "[UNPAIR] MAC and groupToken cleared. Restart to take effect.");
#endif
    } else if (cmd == "CLEAR") {
      prefs.clear();
#if SSCM_DEBUG
      Serial.println("[CLEAR] All NVS data cleared. Restart required.");
#endif
    } else if (cmd == "FACTORY_RESET") {
#if SSCM_DEBUG
      Serial.println("[Serial] Factory reset command received!");
#endif
      factoryReset();
    }
  }

  delay(5);
}
