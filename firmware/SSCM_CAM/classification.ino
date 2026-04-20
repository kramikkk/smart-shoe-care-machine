/*
 * Gemini AI Classification Pipeline
 */

/**
 * Capture frame and POST to backend for Gemini classification
 */
void captureAndPostToBackend() {
  LOG("[CAM→SVR] ── Classification pipeline started ──────────────────");

  if (!is_initialised) {
    LOG("[CAM→SVR] ABORT: Camera not initialised");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
    return;
  }

  // Drain stale frames from the sensor buffer before the real capture.
  // The OV5640 buffers frames continuously; without draining, esp_camera_fb_get()
  // returns the oldest buffered frame (possibly seconds old) rather than a fresh one.
  LOG("[CAM→SVR] Draining 3 stale frames + 500ms AEC settle...");
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);
  }
  delay(500);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    LOG("[CAM→SVR] ERROR: esp_camera_fb_get() returned null");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }
  LOG("[CAM→SVR] Frame captured — " + String(fb->len / 1024) + " KB (" + String(fb->len) + " bytes)");

  // Read backend connection details from NVS (set during pairing flow).
  String wsHost = prefs.getString("wsHost", "");
  uint16_t wsPort = prefs.getUInt("wsPort", 3000);
  String mainId  = prefs.getString("mainId", "");
  String token   = storedGroupToken;

  if (wsHost.isEmpty() || mainId.isEmpty() || token.isEmpty()) {
    LOG("[CAM→SVR] ERROR: Missing backend config in NVS:");
    if (wsHost.isEmpty()) LOG("  · wsHost is empty");
    if (mainId.isEmpty()) LOG("  · mainId is empty");
    if (token.isEmpty())  LOG("  · groupToken is empty");
    esp_camera_fb_return(fb);
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  bool useHttps = (wsPort == 443);
  String url = (useHttps ? "https://" : "http://") + wsHost + ":" + String(wsPort)
               + "/api/device/" + mainId + "/classify";

  LOG("[CAM→SVR] Target : " + url);
  LOG("[CAM→SVR] Token  : " + token.substring(0, 8) + "...");

  HTTPClient http;
  WiFiClientSecure secureClient;
  if (useHttps) {
    secureClient.setInsecure();
    http.begin(secureClient, url);
  } else {
    http.begin(url);
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Group-Token", token);
  http.setTimeout(20000);

  LOG("[CAM→SVR] POST → sending JPEG...");
  unsigned long postStart = millis();
  int httpCode = http.sendRequest("POST", fb->buf, fb->len);
  unsigned long postMs = millis() - postStart;
  esp_camera_fb_return(fb);

  LOG("[CAM→SVR] HTTP " + String(httpCode) + " in " + String(postMs) + " ms");

  if (httpCode >= 200 && httpCode < 300) {
    String body = http.getString();
    LOG("[CAM→SVR] Response body: " + body);
    LOG("[CAM→SVR] OK — Gemini result will be broadcast to MAIN via WebSocket");
    LOG("[CAM→SVR] Sending CAM_STATUS_API_HANDLED to MAIN via ESP-NOW");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_API_HANDLED, "", 0.0f);
  } else {
    String body = http.getString();
    LOG("[CAM→SVR] FAILED — body: " + body);
    LOG("[CAM→SVR] Sending CAM_STATUS_ERROR to MAIN via ESP-NOW");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
  }
  http.end();
  LOG("[CAM→SVR] ── Pipeline done ─────────────────────────────────────");
}
