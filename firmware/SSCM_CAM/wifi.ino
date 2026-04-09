/*
 * WiFi Event Handlers and Connection Logic
 */

unsigned long lastWifiAttemptMs = 0;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000; // 10s cooldown

/**
 * Handle WiFi reconnection requests with cooldown
 * Prevents "cannot set config" errors from rapid retries
 */
void handleWiFiReconnect() {
  if (!wifiReconnectRequested) return;

  unsigned long now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) return;

  wifiReconnectRequested = false;
  lastWifiAttemptMs = now;

  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");

  if (ssid.length() > 0) {
    LOG("[WiFi] Attempting reconnection to " + ssid + "...");
    WiFi.begin(ssid.c_str(), pass.c_str());
    wifiConnectStartMs = now;
  }
}

/**
 * WiFi connection established (Layer 2)
 */
void onWiFiConnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  LOG("[WiFi:EVT] Connected to SSID");
}

/**
 * WiFi IP address assigned (Layer 3)
 */
void onWiFiGotIP(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = true;
  camIp = WiFi.localIP().toString();
  LOG("[WiFi:EVT] IP obtained: " + camIp);
}

/**
 * WiFi disconnected
 */
void onWiFiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = false;
  httpServerStarted = false;
  camIp = "";
  wifiReconnectRequested = true;
  LOG("[WiFi:EVT] Disconnected - scheduled for retry");
}
