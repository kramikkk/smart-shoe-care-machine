/* ===================== CLASSIFICATION FUNCTIONS ===================== */
// Flow: Main board → ESP-NOW → CAM → HTTP → Gemini → WS → Backend
// Offline-capable: result still goes to service logic if backend is down.

void handleClassificationResultFromCAM(String shoeType, float confidence) {
  lastClassificationResult    = shoeType;
  lastClassificationConfidence = confidence;

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
