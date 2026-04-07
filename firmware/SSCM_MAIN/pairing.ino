/* ===================== PAIRING & DEVICE IDENTITY ===================== */

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
  // Use lower 3 bytes of EfuseMac — device-specific (not OUI) part of the MAC
  uint64_t chipid = ESP.getEfuseMac();
  char id[12];
  snprintf(id, sizeof(id), "SSCM-%02X%02X%02X",
           (uint8_t)((chipid >> 16) & 0xFF),
           (uint8_t)((chipid >>  8) & 0xFF),
           (uint8_t)((chipid >>  0) & 0xFF));
  return String(id);
}

void sendDeviceRegistration() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(BACKEND_URL) + "/api/device/register";

#if USE_LOCAL_BACKEND
  http.begin(url);
#else
  WiFiClientSecure secureClient;
  // Note: setInsecure() skips TLS cert verification.
  // Replace with setCACert() for stricter security in production.
  secureClient.setInsecure();
  http.begin(secureClient, url);
#endif

  // Hard timeouts: Render free-tier cold starts can take 10-30s.
  // Without these, the OS TCP timeout (60s) blocks loop() completely.
  http.setConnectTimeout(10000);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"deviceName\":\"Smart Shoe Care Machine\",";
  payload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  http.POST(payload);
  http.end();
}
