/**
 * AI Classification Results
 * Handles the logic for processing and reporting shoe type classification data.
 */

void handleClassificationResultFromCAM(String shoeType, float confidence) {
  LOG("[CLASSIFICATION] Result: " + shoeType +
      " confidence=" + String(confidence * 100, 0) + "%");
  lastClassificationResult = shoeType;
  lastClassificationConfidence = confidence;

  if (wsConnected && isPaired) {
    String msg = "{";
    msg += "\"type\":\"classification-result\",";
    msg += "\"deviceId\":\"" + deviceId + "\",";
    msg += "\"result\":\"" + shoeType + "\",";
    msg += "\"confidence\":" + String(confidence, 4);
    msg += "}";
    webSocket.sendTXT(msg);
    wsLog("info", "Classification result: " + shoeType + " (" +
                      String((int)(confidence * 100)) + "% confidence)");
  }
}

void relayClassificationErrorToBackend(String errorCode) {
  LOG("[CLASSIFICATION] Error: " + errorCode);
  if (!wsConnected || !isPaired)
    return;

  String msg = "{";
  msg += "\"type\":\"classification-error\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"error\":\"" + errorCode + "\"";
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("warn", "Classification error: " + errorCode);
}
