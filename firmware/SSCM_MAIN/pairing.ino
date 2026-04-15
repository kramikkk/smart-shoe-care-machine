/**
 * Device Pairing & Identity
 * Handles unique ID generation, pairing codes, and factory reset procedures.
 */

/**
 * Generate the group token — an 8-digit uppercase hex string shared between MAIN and CAM.
 * XOR with a rotated second random value mixes entropy from two independent hardware RNG calls,
 * reducing any correlation between successive tokens.
 * Format: "A1B2C3D4" (8 hex chars, always uppercase)
 */
String generateGroupToken() {
  uint32_t r1 = esp_random();
  uint32_t r2 = esp_random();
  char token[9];
  snprintf(token, sizeof(token), "%08X", r1 ^ ((r2 << 16) | (r2 >> 16)));
  return String(token);
}

/**
 * Generate a 6-digit numeric pairing code displayed as QR / number on the kiosk screen.
 * The owner enters or scans this to claim the device in the dashboard.
 * Format: "012345" (6 decimal digits, may have leading zeros)
 */
String generatePairingCode() {
  String code = "";
  for (int i = 0; i < 6; i++) {
    code += String(esp_random() % 10);
  }
  return code;
}

/**
 * Generate a persistent device ID from the lower 3 bytes of the eFuse MAC address.
 * The upper bytes are the Espressif OUI and are the same across all modules.
 * Format: "SSCM-A1B2C3" (fixed prefix + 3 hex bytes)
 */
String generateDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[12];
  snprintf(id, sizeof(id), "SSCM-%02X%02X%02X",
           (uint8_t)((chipid >> 16) & 0xFF),
           (uint8_t)((chipid >>  8) & 0xFF),
           (uint8_t)((chipid >>  0) & 0xFF));
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

/**
 * Notify the backend of the current CAM sync state.
 * - If a CAM has completed pairing (pairedCamDeviceId is known), sends the full cam-paired
 *   message which includes the CAM's device ID and IP.
 * - Otherwise sends a lighter cam-sync-status message with just the boolean camSynced flag.
 * Called after WebSocket reconnects to restore dashboard state without re-pairing.
 */
void sendCamSyncStatus() {
  if (!isPaired || !wsConnected) return;

  if (pairedCamDeviceId.length() > 0) {
    sendCamPairedToBackend(); // Full cam identity is known — send the richer message
    return;
  }

  // CAM is either not yet paired or identity unknown — send minimal sync flag only.
  String syncMsg = "{";
  syncMsg += "\"type\":\"cam-sync-status\",";
  syncMsg += "\"deviceId\":\"" + deviceId + "\",";
  syncMsg += "\"camSynced\":" + String(camIsReady ? "true" : "false");
  syncMsg += "}";
  webSocket.sendTXT(syncMsg);
}

/**
 * Full factory reset: turn off all actuators, optionally reset paired CAM,
 * wipe NVS, and restart.
 * CAM reset is sent 3 times with 500ms gaps because ESP-NOW delivery is best-effort
 * and the first packet may be missed while the CAM is still booting.
 */
void factoryReset() {
  allRelaysOff(); // Safety: cut all actuators before wiping state

  wsLog("warn", "Factory reset triggered — final totals: Coin P" +
                    String(totalCoinPesos) + ", Bill P" +
                    String(totalBillPesos) + ", Total P" + String(totalPesos));

  // Tell the paired CAM to wipe its own NVS before we wipe ours.
  if (espNowInitialized && camMacPaired) {
    CamMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.type = CAM_MSG_FACTORY_RESET;
    for (int i = 0; i < 3; i++) {
      esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
      delay(500); // 500ms between retries to maximise delivery probability
    }
    delay(1000); // Allow CAM time to process and restart before MAIN wipes its MAC record
  }

  prefs.clear(); // Wipe the "sscm" NVS namespace (WiFi, pairing, counters, positions)
  delay(500);
  ESP.restart();
}
