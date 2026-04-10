/*
 * Identity, Preferences, and OTA Updates
 */

/**
 * Generate a unique device ID based on MAC address
 * Format: SSCM-CAM-XXXXXX
 */
String generateCamOwnDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[24];
  snprintf(id, sizeof(id), "SSCM-CAM-%02X%02X%02X", (uint8_t)(chipid >> 16),
           (uint8_t)(chipid >> 8), (uint8_t)chipid);
  return String(id);
}

/**
 * Setup Over-The-Air firmware updates
 * Hostname: sscm-cam-XXYY (last 2 bytes of MAC)
 */
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
    // Derive fallback from MAC
    char fallback[9];
    snprintf(fallback, sizeof(fallback), "%02X%02X%02X%02X", mac[2], mac[3],
             mac[4], mac[5]);
    ArduinoOTA.setPassword(fallback);
  }

  ArduinoOTA.onStart([]() { LOG("[OTA] Update starting..."); });
  ArduinoOTA.onEnd([]() { LOG("[OTA] Update complete. Restarting..."); });
  ArduinoOTA.onError([](ota_error_t error) {
    LOG("[OTA] ERROR [" + String(error) + "]");
  });

  ArduinoOTA.begin();
  LOG("[OTA] Ready on " + String(hostname) + " (Pass: token or MAC)");
}

/**
 * Clear all stored preferences and restart
 */
void factoryReset() {
  LOG("[SYSTEM] Factory reset: clearing all preferences and restarting...");
  prefs.clear();
  delay(500);
  ESP.restart();
}
