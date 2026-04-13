/**
 * WiFi & OTA Management
 * Handles connection, SoftAP portal for configuration, and Over-The-Air updates.
 */

String getWiFiListHTML() {
  String options = "";
  int n = WiFi.scanNetworks();

  if (n <= 0) {
    options += "<option>No networks found</option>";
  } else {
    for (int i = 0; i < n; i++) {
      String ssid = WiFi.SSID(i);
      int rssi = WiFi.RSSI(i);

      // Sanitize SSID for HTML
      ssid.replace("'", "");
      ssid.replace("\"", "");
      ssid.replace("<", "");
      ssid.replace(">", "");

      options += "<option value='";
      options += ssid;
      options += "'>";
      options += ssid;
      options += " (";
      options += rssi;
      options += " dBm)</option>";
    }
  }

  WiFi.scanDelete();
  return options;
}

void startSoftAP() {
  if (softAPStarted)
    return;

  softAPStarted = true;
  LOG("[WIFI:AP] Starting soft AP for configuration");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("Smart Shoe Care Machine Setup");

  wifiServer.begin();
  LOG("[WIFI:AP] Ready on http://192.168.4.1");
}

String urlDecode(String input) {
  input.replace("+", " ");
  for (int i = 0; i < input.length(); i++) {
    if (input[i] == '%' && i + 2 < input.length()) {
      String hex = input.substring(i + 1, i + 3);
      char ch = strtol(hex.c_str(), NULL, 16);
      input = input.substring(0, i) + ch + input.substring(i + 3);
    }
  }
  return input;
}

void handleWiFiPortal() {
  WiFiClient client = wifiServer.available();
  if (!client)
    return;

  unsigned long timeout = millis() + 100;
  while (!client.available() && millis() < timeout) {
    delay(1);
  }

  client.setTimeout(100);
  String request = "";
  if (client.available()) {
    const size_t MAX_REQUEST_SIZE = 2048;
    request = "";
    while (client.available() && request.length() < MAX_REQUEST_SIZE) {
      request += (char)client.read();
    }
    while (client.available())
      client.read();
  }

  if (request.indexOf("ssid=") != -1) {
    int ssidIndex = request.indexOf("ssid=") + 5;
    int passIndex = request.indexOf("&pass=");
    if (passIndex == -1) {
      client.stop();
      return;
    }

    String ssid = request.substring(ssidIndex, passIndex);
    String pass = request.substring(passIndex + 6);

    ssid = urlDecode(ssid);
    ssid.trim();
    pass = urlDecode(pass);
    pass.trim();

    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);

    String confirmPage = FPSTR(CONFIRM_HTML);
    confirmPage.replace("{{SSID}}", ssid);

    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html; charset=UTF-8");
    client.println("Connection: close");
    client.println();
    client.print(confirmPage);
    client.flush();
    client.stop();

    delay(1500);
    ESP.restart();
  }
  else {
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html");
    client.println("Connection: close");
    client.println();
    String page = WIFI_HTML;
    page.replace("{{WIFI_LIST}}", getWiFiListHTML());
    client.print(page);
  }

  client.stop();
}

void connectWiFi() {
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (ssid.length() == 0) {
    LOG("[WIFI] No SSID stored - starting soft AP for setup");
    startSoftAP();
    return;
  }

  LOG("[WIFI] Attempting connection to: " + ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  wifiStartTime = millis();
}

void setupOTA() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char hostname[24];
  snprintf(hostname, sizeof(hostname), "sscm-main-%02X%02X", mac[4], mac[5]);
  ArduinoOTA.setHostname(hostname);
  if (deviceId.length() > 0) {
    ArduinoOTA.setPassword(deviceId.c_str());
  } else {
    ArduinoOTA.setPassword("SSCM-OTA");
  }
  ArduinoOTA.onStart([]() {
    allRelaysOff();
    wsLog("warn", "OTA firmware update started — device will restart");
  });
  ArduinoOTA.onEnd(
      []() { wsLog("info", "OTA update complete — restarting now"); });
  ArduinoOTA.onError([](ota_error_t error) {
    wsLog("error", "OTA update failed — error code: " + String(error));
  });
  ArduinoOTA.begin();
}
