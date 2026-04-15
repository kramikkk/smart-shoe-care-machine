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

  // Drain stale frames from the sensor buffer before the real capture.
  // The OV5640 buffers frames continuously; without draining, esp_camera_fb_get()
  // returns the oldest buffered frame (possibly seconds old) rather than a fresh one.
  for (int i = 0; i < 3; i++) {
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);
  }
  // Allow AEC (auto exposure) to settle after the drain before taking the real frame.
  // Without this delay, the first post-drain frame can be incorrectly exposed.
  delay(500);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    LOG("[PIPELINE] Frame capture failed");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  // Read backend connection details from NVS (set during pairing flow).
  String wsHost = prefs.getString("wsHost", "");
  uint16_t wsPort = prefs.getUInt("wsPort", 3000);
  String mainId  = prefs.getString("mainId", ""); // MAIN device ID — used in the endpoint path
  String token   = storedGroupToken;               // X-Group-Token header validates the request

  if (wsHost.isEmpty() || mainId.isEmpty() || token.isEmpty()) {
    LOG("[CAM:CLASS] ERROR: Missing backend config");
    if (wsHost.isEmpty()) LOG("  - wsHost is empty");
    if (mainId.isEmpty()) LOG("  - mainId is empty");
    if (token.isEmpty())  LOG("  - groupToken is empty");
    esp_camera_fb_return(fb);
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
    return;
  }

  // Endpoint: POST /api/device/{mainId}/classify
  // Backend receives the JPEG, calls Gemini 2.0 Flash, and broadcasts the result
  // back to the kiosk tablet via WebSocket. CAM does not parse the Gemini response.
  bool useHttps = (wsPort == 443);
  String url = (useHttps ? "https://" : "http://") + wsHost + ":" + String(wsPort)
               + "/api/device/" + mainId + "/classify";

  HTTPClient http;
  WiFiClientSecure secureClient;
  if (useHttps) {
    // setInsecure() skips TLS certificate verification.
    // Acceptable here: traffic stays on the local LAN or a trusted cloud endpoint,
    // and the group token provides application-level authenticity.
    secureClient.setInsecure();
    http.begin(secureClient, url);
  } else {
    http.begin(url);
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Group-Token", token); // Backend validates this matches the device's stored token
  http.setTimeout(20000); // 20s — Gemini inference can take several seconds under load

  LOG("[PIPELINE] Posting frame (" + String(fb->len) + " bytes) to " + url);
  int httpCode = http.sendRequest("POST", fb->buf, fb->len);
  esp_camera_fb_return(fb); // Return buffer to driver as soon as POST is sent

  if (httpCode >= 200 && httpCode < 300) {
    // Backend accepted the frame and will relay the Gemini result via WebSocket to MAIN.
    // CAM signals API_HANDLED so MAIN knows it should not time out waiting for an ESP-NOW result.
    LOG("[PIPELINE] Posted successfully. Awaiting WS broadcast to main.");
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_API_HANDLED, "", 0.0f);
  } else {
    LOG("[PIPELINE] HTTP Post Failed: " + String(httpCode));
    sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_ERROR, "", 0.0f);
  }
  http.end();
}
