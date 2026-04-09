/*
 * WiFi Event Handlers and Connection Logic
 */

unsigned long lastWifiAttemptMs = 0;
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000;  // 5s cooldown
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000; // 20s timeout before retry

/**
 * Handle WiFi reconnection requests with cooldown
 * Prevents "cannot set config" errors from rapid retries
 */
void handleWiFiReconnect() {
  unsigned long now = millis();
  
  // If connection attempt is timing out, force disconnect and retry
  if (wifiConnectStartMs > 0 && (now - wifiConnectStartMs) > WIFI_CONNECT_TIMEOUT_MS) {
    if (WiFi.status() != WL_CONNECTED && !wifiReconnectRequested) {
      LOG("[WiFi] Connection timeout - forcing disconnect & retry");
      WiFi.disconnect();
      wifiReconnectRequested = true;
      wifiConnectStartMs = 0;
      lastWifiAttemptMs = now;
      return;
    }
  }
  
  if (!wifiReconnectRequested) return;

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
  wifiReconnectRequested = false;  // Clear reconnect flag on successful connection
  wifiConnectStartMs = 0;          // Clear timeout timer
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
  
  // Only restart reconnect if we were previously connected
  // This prevents spurious retries during initial connection
  if (wifiConnectStartMs == 0) {
    wifiReconnectRequested = true;
    LOG("[WiFi:EVT] Disconnected - scheduled for retry");
  } else {
    LOG("[WiFi:EVT] Disconnected during connection attempt");
  }
}
