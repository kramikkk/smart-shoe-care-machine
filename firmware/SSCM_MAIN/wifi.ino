/**
 * ===================== WIFI FUNCTIONS =====================
 *
 * Manages WiFi connectivity with two modes:
 *   1. STA mode — Connects to user's home/shop WiFi using stored credentials
 *   2. SoftAP mode — Creates "Smart Shoe Care Machine Setup" hotspot with a
 *      captive portal for initial WiFi credential entry
 *
 * WiFi lifecycle:
 *   Boot → check NVS for credentials → STA connect → success → WebSocket
 *     └→ no credentials → SoftAP → user enters WiFi → save to NVS → restart
 *     └→ connect timeout → SoftAP fallback → exponential retry
 */
#include "esp_task_wdt.h"

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
      ssid.replace("'",  "");
      ssid.replace("\"", "");
      ssid.replace("<",  "");
      ssid.replace(">",  "");

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
  if (softAPStarted) return;
  softAPStarted = true;

  WiFi.persistent(false);
  esp_task_wdt_deinit();
  WiFi.softAP("Smart Shoe Care Machine Setup");
  LOG("[SoftAP] Started: " + WiFi.softAPIP().toString());
  wifiServer.begin();
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
  if (!client) return;

  unsigned long timeout = millis() + 100;
  while (!client.available() && millis() < timeout) {
    delay(1);
  }

  client.setTimeout(100);
  String request = "";
  if (client.available()) {
    const size_t MAX_REQUEST_SIZE = 2048;
    while (client.available() && request.length() < MAX_REQUEST_SIZE) {
      request += (char)client.read();
    }
    while (client.available()) client.read();
  }

  if (request.indexOf("ssid=") != -1) {
    int ssidIndex = request.indexOf("ssid=") + 5;
    int passIndex = request.indexOf("&pass=");
    if (passIndex == -1) {
      client.stop();
      return;
    }

    String ssid = urlDecode(request.substring(ssidIndex, passIndex));
    String pass = urlDecode(request.substring(passIndex + 6));
    ssid.trim();
    pass.trim();

    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    LOG("[WiFi] Credentials saved: " + ssid);

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
  } else {
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html");
    client.println("Connection: close");
    client.println();
    String page = WIFI_HTML;
    page.replace("{{WIFI_LIST}}", getWiFiListHTML());
    client.print(page);
    client.stop();
  }
}

void connectWiFi() {
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (ssid.length() == 0) {
    LOG("[WiFi] No credentials — starting SoftAP");
    startSoftAP();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  wifiStartTime = millis();
  LOG("[WiFi] Connecting to: " + ssid);
}
