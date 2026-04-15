/*
 * Identity, Preferences, and OTA Updates
 */

/**
 * Generate a unique device ID from the lower 3 bytes of the chip's eFuse MAC address.
 * Format: SSCM-CAM-XXXXXX (e.g. SSCM-CAM-A1B2C3)
 * Lower bytes are used because the upper bytes are the Espressif OUI (same across all modules).
 */
String generateCamOwnDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char id[24];
  snprintf(id, sizeof(id), "SSCM-CAM-%02X%02X%02X",
           (uint8_t)(chipid >> 16),
           (uint8_t)(chipid >> 8),
           (uint8_t)chipid);
  return String(id);
}

/**
 * Configure and start ArduinoOTA.
 * Hostname: sscm-cam-XXYY (last 2 MAC bytes for easy identification on the network).
 * Password: the full device ID (e.g. SSCM-CAM-A1B2C3) if available;
 *           falls back to 8-hex-char MAC suffix if ID generation failed at boot.
 */
void setupOTA() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char hostname[24];
  snprintf(hostname, sizeof(hostname), "sscm-cam-%02X%02X", mac[4], mac[5]);
  ArduinoOTA.setHostname(hostname);

  if (camOwnDeviceId.length() > 0) {
    ArduinoOTA.setPassword(camOwnDeviceId.c_str()); // e.g. "SSCM-CAM-A1B2C3"
  } else {
    // Fallback: last 4 MAC bytes as hex string when device ID is unavailable
    char fallback[9];
    snprintf(fallback, sizeof(fallback), "%02X%02X%02X%02X",
             mac[2], mac[3], mac[4], mac[5]);
    ArduinoOTA.setPassword(fallback);
  }

  ArduinoOTA.onStart([]() { LOG("[OTA] Update starting..."); });
  ArduinoOTA.onEnd([]() { LOG("[OTA] Update complete. Restarting..."); });
  ArduinoOTA.onError([](ota_error_t error) {
    LOG("[OTA] ERROR [" + String(error) + "]");
  });

  ArduinoOTA.begin();
  LOG("[OTA] Ready on " + String(hostname) + " (password = device ID, e.g. SSCM-CAM-XXXXXX)");
}

/**
 * Wipe all NVS keys in the "cam" namespace and restart.
 * This clears: paired MAC, group token, WiFi credentials, backend host/port, mainId.
 * Called from loop() only — never call from ISR/callback context.
 */
void factoryReset() {
  LOG("[SYSTEM] Factory reset: clearing all preferences and restarting...");
  prefs.clear();  // Clears the "cam" NVS namespace opened in setup()
  delay(500);
  ESP.restart();
}
