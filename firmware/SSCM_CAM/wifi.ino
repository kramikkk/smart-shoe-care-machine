/*
 * WiFi Event Handlers and Connection Logic
 *
 * Two-level reconnect scheme:
 *   1. WIFI_CONNECT_TIMEOUT_MS (20s): if a connect attempt stalls (no IP within 20s),
 *      force a WiFi.disconnect() to reset the driver, then wait WIFI_RETRY_INTERVAL_MS.
 *   2. WIFI_RETRY_INTERVAL_MS (5s): minimum gap between successive WiFi.begin() calls
 *      to prevent flooding the driver with begin() while an attempt is in flight.
 */

unsigned long lastWifiAttemptMs = 0;
const unsigned long WIFI_RETRY_INTERVAL_MS  = 5000;  // Minimum ms between retries
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000; // ms before declaring a connect attempt stalled

/**
 * Robust reconnect handler — call every loop() iteration.
 * Step 1: if the current connect attempt has exceeded WIFI_CONNECT_TIMEOUT_MS with no IP,
 *         force a disconnect to reset STA state and schedule a retry.
 * Step 2: when wifiReconnectRequested is set and the cooldown has elapsed, call WiFi.begin().
 */
void handleWiFiReconnect() {
  unsigned long now = millis();

  // Step 1 — stalled connect attempt: force disconnect to allow a clean retry.
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

  // Step 2 — respect the inter-retry cooldown before calling begin() again.
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
 * Layer-2 association complete (IP not yet assigned).
 * Informational only — wifiConnected is set in onWiFiGotIP once the IP is valid.
 */
void onWiFiConnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  LOG("[WiFi:EVT] Connected to SSID");
}

/**
 * DHCP lease obtained — WiFi is now fully usable.
 * Records the IP for inclusion in the PairingAck sent to MAIN.
 */
void onWiFiGotIP(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = true;
  wifiReconnectRequested = false; // Cancel any pending retry
  wifiConnectStartMs = 0;         // Clear the stall timeout timer
  camIp = WiFi.localIP().toString();
  LOG("[WiFi:EVT] IP obtained: " + camIp);
}

/**
 * WiFi disconnected event.
 * wifiConnectStartMs == 0 means we were previously connected (connect attempt already finished).
 * wifiConnectStartMs != 0 means we dropped during an active connect attempt — do not re-schedule
 * here; the stall-timeout path in handleWiFiReconnect() will handle it on the next tick.
 */
void onWiFiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = false;
  httpServerStarted = false; // HTTP server must be restarted after reconnect
  camIp = "";

  if (wifiConnectStartMs == 0) {
    // Was fully connected and dropped — schedule a reconnect attempt.
    wifiReconnectRequested = true;
    LOG("[WiFi:EVT] Disconnected - scheduled for retry");
  } else {
    // Dropped mid-connect — let the stall-timeout path in handleWiFiReconnect() retry.
    LOG("[WiFi:EVT] Disconnected during connection attempt");
  }
}
