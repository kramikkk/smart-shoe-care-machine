/*
 * Gemini AI Classification Pipeline
 */

/**
 * Capture frame and POST to backend for Gemini classification
 */
void captureAndPostToBackend() {
  LOG("[PIPELINE] Starting Gemini classification capture...");

  if (!is_initialised) {
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
    return;
  }

  // Drain buffer for fresh capture
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);
  }
  delay(500); // Wait for AEC

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    LOG("[PIPELINE] Frame capture failed");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  String wsHost = prefs.getString("wsHost", "");
  uint16_t wsPort = prefs.getUInt("wsPort", 3000);
  String mainId = prefs.getString("mainId", "");
  String token = storedGroupToken;

  if (wsHost.isEmpty() || mainId.isEmpty() || token.isEmpty()) {
    LOG("[CAM:CLASS] ERROR: Missing backend config");
    if (wsHost.isEmpty()) LOG("  - wsHost is empty");
    if (mainId.isEmpty()) LOG("  - mainId is empty");
    if (token.isEmpty())  LOG("  - groupToken is empty");
    esp_camera_fb_return(fb);
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  bool useHttps = (wsPort == 443);
  String url = (useHttps ? "https://" : "http://") + wsHost + ":" + String(wsPort) + "/api/device/" + mainId + "/classify";

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
  http.setTimeout(20000); // 20s limit for Gemini (parity with original)

  LOG("[PIPELINE] Posting frame (" + String(fb->len) + " bytes) to " + url);
  int httpCode = http.sendRequest("POST", fb->buf, fb->len);
  esp_camera_fb_return(fb);

  if (httpCode >= 200 && httpCode < 300) {
    LOG("[PIPELINE] Posted successfully. Awaiting WS broadcast to main.");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_API_HANDLED, "", 0.0f);
  } else {
    LOG("[PIPELINE] HTTP Post Failed: " + String(httpCode));
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
  }
  http.end();
}
