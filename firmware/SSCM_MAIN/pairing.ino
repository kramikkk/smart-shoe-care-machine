/**
 * Device Pairing & Identity
 * Handles unique ID generation, pairing codes, and factory reset procedures.
 */

String generateGroupToken() {
  uint32_t r1 = esp_random();
  uint32_t r2 = esp_random();
  char token[9];
  snprintf(token, sizeof(token), "%08X", r1 ^ ((r2 << 16) | (r2 >> 16)));
  return String(token);
}

String generatePairingCode() {
  String code = "";
  for (int i = 0; i < 6; i++) {
    code += String(esp_random() % 10);
  }
  return code;
}

String generateDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[12];
  snprintf(id, sizeof(id), "SSCM-%02X%02X%02X",
           (uint8_t)((chipid >> 16) & 0xFF), (uint8_t)((chipid >> 8) & 0xFF),
           (uint8_t)((chipid >> 0) & 0xFF));
  return String(id);
}

void sendCamPairedToBackend() {
  if (!wsConnected)
    return;

  String msg = "{";
  msg += "\"type\":\"cam-paired\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  if (pairedCamIp.length() > 0) {
    msg += ",\"camIp\":\"" + pairedCamIp + "\"";
  }
  msg += "}";
  webSocket.sendTXT(msg);
  wsLog("info", "CAM paired: " + pairedCamDeviceId +
                    (pairedCamIp.length() > 0 ? " @ " + pairedCamIp : ""));
}

void sendCamSyncStatus() {
  if (!isPaired || !wsConnected)
    return;

  if (pairedCamDeviceId.length() > 0) {
    sendCamPairedToBackend();
    return;
  }

  String syncMsg = "{";
  syncMsg += "\"type\":\"cam-sync-status\",";
  syncMsg += "\"deviceId\":\"" + deviceId + "\",";
  syncMsg += "\"camSynced\":" + String(camIsReady ? "true" : "false");
  syncMsg += "}";
  webSocket.sendTXT(syncMsg);
}

void factoryReset() {
  allRelaysOff();
  wsLog("warn", "Factory reset triggered — final totals: Coin P" +
                    String(totalCoinPesos) + ", Bill P" +
                    String(totalBillPesos) + ", Total P" + String(totalPesos));
  
  if (espNowInitialized && camMacPaired) {
    CamMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.type = CAM_MSG_FACTORY_RESET;
    for (int i = 0; i < 3; i++) {
      esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
      delay(500);
    }
    delay(1000);
  }

  prefs.clear();
  delay(500);
  ESP.restart();
}
