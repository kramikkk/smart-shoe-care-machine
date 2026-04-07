/**
 * ===================== CLASSIFICATION FUNCTIONS =====================
 *
 * Handles result processing after the ESP32-CAM completes image classification.
 *
 * Data flow:
 *   1. SSCM-MAIN sends CLASSIFY_REQUEST to SSCM-CAM via ESP-NOW
 *   2. SSCM-CAM captures image → Posts to Gemini API via HTTP
 *   3. SSCM-CAM sends CLASSIFY_RESULT to SSCM-MAIN via ESP-NOW
 *   4. SSCM-MAIN receives result (via onDataRecv → espNowQueue → loop)
 *   5. SSCM-MAIN updates local state and relays to Backend/Dashboard via WS
 *
 * Offline capable: The system design allows for fallback logic if the backend
 * is unreachable, as long as the CAM can still reach the Gemini API directly.
 */

void handleClassificationResultFromCAM(String shoeType, float confidence) {
  lastClassificationResult    = shoeType;
  lastClassificationConfidence = confidence;

  LOG("[Classification] " + shoeType + " (" + String((int)(confidence * 100)) + "%)");

  if (wsConnected && isPaired) {
    webSocket.sendTXT("{\"type\":\"classification-result\",\"deviceId\":\"" + deviceId +
                      "\",\"result\":\"" + shoeType +
                      "\",\"confidence\":" + String(confidence, 4) + "}");
    wsLog("info", "Classification result: " + shoeType + " (" +
                  String((int)(confidence * 100)) + "% confidence)");
  }
}

void relayClassificationErrorToBackend(String errorCode) {
  if (!wsConnected || !isPaired) return;

  LOG("[Classification] Error: " + errorCode);
  webSocket.sendTXT("{\"type\":\"classification-error\",\"deviceId\":\"" + deviceId +
                    "\",\"error\":\"" + errorCode + "\"}");
  wsLog("warn", "Classification error: " + errorCode);
}

void sendCamPairedToBackend() {
  if (!wsConnected) return;

  String msg = "{\"type\":\"cam-paired\",\"deviceId\":\"" + deviceId +
               "\",\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  if (pairedCamIp.length() > 0) {
    msg += ",\"camIp\":\"" + pairedCamIp + "\"";
  }
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("info", "CAM paired: " + pairedCamDeviceId +
                (pairedCamIp.length() > 0 ? " @ " + pairedCamIp : ""));
}

void sendCamSyncStatus() {
  if (!isPaired || !wsConnected) return;

  if (pairedCamDeviceId.length() > 0) {
    sendCamPairedToBackend();
    return;
  }

  // Fallback: legacy cam-sync-status message for backward compat
  webSocket.sendTXT("{\"type\":\"cam-sync-status\",\"deviceId\":\"" + deviceId +
                    "\",\"camSynced\":" + String(camIsReady ? "true" : "false") + "}");
}
