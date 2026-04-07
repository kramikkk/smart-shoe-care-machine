/**
 * ===================== PAIRING & DEVICE IDENTITY =====================
 *
 * Manages the unique identity and pairing lifecycle of the machine.
 *
 * Device ID: Generated from the ESP32's baked-in MAC address (e.g., SSCM-A1B2C3)
 * Group Token: Random 8-character hex string linking MAIN + CAM + Backend
 * Pairing Code: 6-digit random code shown on the dashboard for initial link
 *
 * sendDeviceRegistration() is called upon WiFi connection to ensure the
 * backend database knows this specific MAC address exists.
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
  secureClient.setInsecure();
  http.begin(secureClient, url);
#endif

  http.setConnectTimeout(10000);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"deviceName\":\"Smart Shoe Care Machine\",";
  payload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  int httpCode = http.POST(payload);
  http.end();

  LOG("[Registration] HTTP " + String(httpCode));
}
