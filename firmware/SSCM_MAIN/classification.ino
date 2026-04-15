/**
 * Classification result handlers.
 * These are called from loop() after being dequeued from the ESP-NOW queue.
 * They relay the outcome to the backend via WebSocket so the kiosk tablet can
 * display the result and proceed to service selection.
 */

/**
 * Relay a successful classification result to the backend.
 * shoeType: "mesh", "canvas", or "rubber" (from Gemini via CAM HTTP POST).
 * confidence: 0.0–1.0 float (Gemini's reported confidence for the classification).
 * The backend then sends a "classification-result" WebSocket event to the kiosk tablet.
 */
void handleClassificationResultFromCAM(String shoeType, float confidence) {
  LOG("[CLASSIFICATION] Result: " + shoeType +
      " confidence=" + String(confidence * 100, 0) + "%");

  // Cache the last result — used for service start and dashboard display.
  lastClassificationResult     = shoeType;
  lastClassificationConfidence = confidence;

  if (wsConnected && isPaired) {
    String msg = "{";
    msg += "\"type\":\"classification-result\",";
    msg += "\"deviceId\":\"" + deviceId + "\",";
    msg += "\"result\":\"" + shoeType + "\",";
    msg += "\"confidence\":" + String(confidence, 4); // 4 decimal places for backend precision
    msg += "}";
    webSocket.sendTXT(msg);
    wsLog("info", "Classification result: " + shoeType + " (" +
                      String((int)(confidence * 100)) + "% confidence)");
  }
}

/**
 * Relay a classification failure to the backend.
 * errorCode identifies the failure reason (e.g. "CAM_BUSY", "CAMERA_NOT_READY",
 * "CAM_RESPONSE_TIMEOUT", "CLASSIFICATION_ERROR").
 * The backend forwards this to the kiosk tablet so the UI can show a retry prompt.
 */
void relayClassificationErrorToBackend(String errorCode) {
  LOG("[CLASSIFICATION] Error: " + errorCode);
  if (!wsConnected || !isPaired) return;

  String msg = "{";
  msg += "\"type\":\"classification-error\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"error\":\"" + errorCode + "\"";
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("warn", "Classification error: " + errorCode);
}
