/**
 * WiFi & OTA Management
 * Handles connection, SoftAP portal for configuration, and Over-The-Air updates.
 */

const char *wifiStatusStr(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS:    return "IDLE";
    case WL_NO_SSID_AVAIL:  return "NO_SSID";
    case WL_SCAN_COMPLETED: return "SCAN_DONE";
    case WL_CONNECTED:      return "CONNECTED";
    case WL_CONNECT_FAILED: return "CONNECT_FAILED";
    case WL_CONNECTION_LOST:return "CONNECTION_LOST";
    case WL_DISCONNECTED:   return "DISCONNECTED";
    default:                return "UNKNOWN";
  }
}

/**
 * Scan for available WiFi networks and return an HTML <option> list for the portal page.
 * SSID values are sanitised by stripping quotes and angle brackets to prevent
 * HTML injection in the portal page when an AP has a malicious SSID.
 */
String getWiFiListHTML() {
  String options = "";

  // Abort any pending WiFi.begin() before scanning — the STA radio cannot scan
  // while it is actively associating. disconnect(false) stops the attempt without
  // turning off the radio so the SoftAP stays up.
  WiFi.disconnect(false);
  delay(100); // Let the radio settle before issuing a scan command

  int n = WiFi.scanNetworks();

  if (n == WIFI_SCAN_FAILED) {
    // Radio was not ready — show a retry prompt rather than "no networks"
    LOG("[WIFI] Scan failed (radio not ready) — user should rescan");
    options += "<option value=''>Scan failed — tap Scan Again</option>";
  } else if (n == 0) {
    options += "<option value=''>No networks found</option>";
  } else {
    for (int i = 0; i < n; i++) {
      String ssid = WiFi.SSID(i);
      int rssi    = WiFi.RSSI(i);

      // Strip HTML-unsafe characters from SSIDs to prevent injection in the portal page.
      ssid.replace("'",  "");
      ssid.replace("\"", "");
      ssid.replace("<",  "");
      ssid.replace(">",  "");

      options += "<option value='" + ssid + "'>" + ssid + " (" + rssi + " dBm)</option>";
    }
    LOG("[WIFI] Scan found " + String(n) + " network(s)");
  }

  WiFi.scanDelete(); // Free scan results from heap
  return options;
}

/**
 * Start the captive portal SoftAP for initial WiFi provisioning.
 * Uses WIFI_AP_STA mode so ESP-NOW (STA radio) remains functional alongside the AP.
 * The portal serves on 192.168.4.1 (default ESP32 SoftAP address).
 */
void startSoftAP() {
  if (softAPStarted) return;

  softAPStarted = true;
  LOG("[WIFI:AP] Starting soft AP for configuration");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA); // AP + STA simultaneously — STA needed for ESP-NOW channel lock
  WiFi.softAP("Smart Shoe Care Machine Setup");

  wifiServer.begin();
  LOG("[WIFI:AP] Ready on http://192.168.4.1");
}

/**
 * Decode a URL-encoded string from an HTML form POST body.
 * Browser form submissions encode spaces as '+' and special chars as %XX hex sequences.
 * This is required to correctly handle WiFi passwords with symbols (e.g. @, #, &).
 */
String urlDecode(String input) {
  input.replace("+", " "); // Form encoding: '+' represents a space
  for (int i = 0; i < input.length(); i++) {
    if (input[i] == '%' && i + 2 < input.length()) {
      String hex = input.substring(i + 1, i + 3);
      char ch = strtol(hex.c_str(), NULL, 16); // Convert hex pair to ASCII character
      input = input.substring(0, i) + ch + input.substring(i + 3);
    }
  }
  return input;
}

/**
 * Handle one HTTP request from the SoftAP captive portal.
 * Called in loop() when softAPStarted is true.
 *
 * Two cases:
 *   1. POST with "ssid=" in body — save credentials to NVS and restart in STA mode.
 *   2. GET (no ssid) — serve the WiFi selection HTML page.
 *
 * The 100ms client read timeout prevents the handler from blocking loop() waiting
 * for a slow or stalled client to send headers.
 */
void handleWiFiPortal() {
  WiFiClient client = wifiServer.available();
  if (!client) return;
  String portalDeviceId = deviceId.length() > 0 ? deviceId : "SSCM-UNKNOWN";

  unsigned long timeout = millis() + 100; // 100ms max wait for client to send request headers
  while (!client.available() && millis() < timeout) {
    delay(1);
  }

  client.setTimeout(100);
  String request = "";
  if (client.available()) {
    const size_t MAX_REQUEST_SIZE = 2048; // Cap to avoid heap exhaustion from large POST bodies
    while (client.available() && request.length() < MAX_REQUEST_SIZE) {
      request += (char)client.read();
    }
    while (client.available()) client.read(); // Drain any remaining bytes
  }

  if (request.indexOf("ssid=") != -1) {
    // Credentials form submitted — parse, URL-decode, persist, and restart.
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

    String confirmPage = FPSTR(CONFIRM_HTML);
    confirmPage.replace("{{SSID}}", ssid);
    confirmPage.replace("{{DEVICE_ID}}", portalDeviceId);

    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html; charset=UTF-8");
    client.println("Connection: close");
    client.println();
    client.print(confirmPage);
    client.flush();
    client.stop();

    delay(1500); // Brief pause so the browser can render the confirm page before restart
    ESP.restart();
  } else {
    // No form data — serve the WiFi selection page with scanned network list.
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: text/html");
    client.println("Connection: close");
    client.println();
    String page = WIFI_HTML;
    page.replace("{{WIFI_LIST}}", getWiFiListHTML());
    page.replace("{{DEVICE_ID}}", portalDeviceId);
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

  // Keep the portal reachable while retrying STA: AP_STA lets both run together.
  if (!softAPStarted) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP("Smart Shoe Care Machine Setup");
    wifiServer.begin();
    softAPStarted = true;
    LOG("[WIFI:AP] Portal ready on http://192.168.4.1 (retrying STA)");
  }

  // Disconnect any in-flight attempt before starting a new one. Without this,
  // WiFi.begin() returns "sta is connecting, cannot set config" when the driver
  // is still associating from the previous call.
  WiFi.disconnect(false);
  LOG("[WIFI] Connecting to: " + ssid + " (status=" + wifiStatusStr(WiFi.status()) + ")");
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
