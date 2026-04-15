/**
 * WebSocket & Backend Communication
 * Handles real-time status updates, command reception, and device registration.
 */

/**
 * Send a log entry to the backend via WebSocket.
 * The backend stores it in the device log and streams it to the owner dashboard.
 * level: "info", "warn", or "error"
 * Special characters in msg are escaped so the JSON string remains valid.
 */
void wsLog(const char *level, const String &msg) {
  if (!wsConnected || deviceId.length() == 0) return;
  // JSON-escape the message body to prevent malformed payloads from embedded quotes or newlines.
  String safe = msg;
  safe.replace("\\", "\\\\");
  safe.replace("\"", "\\\"");
  safe.replace("\n", "\\n");
  safe.replace("\r", "\\r");
  String payload = "{\"type\":\"firmware-log\",\"deviceId\":\"" + deviceId +
                   "\",\"level\":\"" + String(level) + "\",\"message\":\"" +
                   safe + "\"}";
  webSocket.sendTXT(payload);
}

/**
 * Register this device with the backend over HTTP.
 * Called once after WiFi connects when the device is not yet paired (isPaired == false).
 * The backend creates a device record and makes the pairingCode available on the kiosk screen
 * as a QR code so the owner can claim the device from the dashboard.
 *
 * pairingCode is required — without it the API returns 400 and pairing cannot proceed.
 * groupToken is optional but included when available (8-char hex from generateGroupToken()).
 * setInsecure() skips TLS certificate verification for the HTTPS production endpoint.
 */
void sendDeviceRegistration() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(BACKEND_URL) + "/api/device/register";

#if USE_LOCAL_BACKEND
  http.begin(url);
#else
  WiFiClientSecure secureClient;
  secureClient.setInsecure(); // Skip cert verification — token + deviceId provide authenticity
  http.begin(secureClient, url);
#endif

  http.setConnectTimeout(10000); // 10s connect timeout (server may be cold-starting on Render)
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"pairingCode\":\"" + pairingCode + "\","; // 6-digit code displayed on kiosk
  if (groupToken.length() == 8) {
    payload += "\"groupToken\":\"" + groupToken + "\",";
  }
  payload += "\"deviceName\":\"Smart Shoe Care Machine\",";
  payload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"";
  payload += "}";

  int httpResponseCode = http.POST(payload);
  http.end();
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_DISCONNECTED:
    wsConnected = false;
    LOG("[WS] DISCONNECTED");
    break;

  case WStype_CONNECTED: {
    wsConnected = true;
    LOG("[WS] CONNECTED");
    // Subscribe to device-specific messages on the backend pub/sub channel.
    String subMsg = "{\"type\":\"subscribe\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(subMsg);
    wsLog("info", "WS Connected (firmware v" + String(FIRMWARE_VERSION) + ")");

    // Push current state immediately so the backend marks the device as online
    // without waiting for the next 5s status heartbeat.
    String statusMsg = "{\"type\":\"status-update\",\"deviceId\":\"" + deviceId +
                       "\",\"camSynced\":" + (camIsReady ? "true" : "false") +
                       ",\"isPaired\":" + (isPaired ? "true" : "false") + "}";
    webSocket.sendTXT(statusMsg);
    lastStatusUpdate = millis();
    break;
  }

  case WStype_TEXT: {
    String message = String((char *)payload);

    if (message.indexOf("\"type\":\"status-ack\"") != -1) {
      // Backend sends status-ack in response to subscribe, echoing the device's
      // current DB state (paired/unpaired). Used to sync firmware state with DB
      // after a reboot or reconnect without requiring a dashboard action.
      bool dbPaired = (message.indexOf("\"paired\":true") != -1);
      if (dbPaired && !isPaired) {
        isPaired = true;
        prefs.putBool("paired", true);
        LOG("[PAIRING] Device paired by backend");
      } else if (!dbPaired && isPaired) {
        // DB says unpaired — clear local pairing state and re-register to get a fresh pairing code.
        isPaired = false;
        prefs.putBool("paired", false);
        LOG("[PAIRING] Device unpaired by backend");
        pairingCode = generatePairingCode();
        sendDeviceRegistration();
      }

    } else if (message.indexOf("\"type\":\"device-update\"") != -1) {
      // Real-time pairing change triggered by an owner action in the dashboard.
      if (message.indexOf("\"paired\":true") != -1) {
        if (!isPaired) {
          isPaired = true;
          prefs.putBool("paired", true);
          wsLog("info", "Device paired by dashboard");
        }
      } else if (message.indexOf("\"paired\":false") != -1) {
        if (isPaired) {
          // Owner unpaired the device — restart to return to unpaired state cleanly.
          isPaired = false;
          prefs.putBool("paired", false);
          wsLog("warn", "Device unpaired — restarting");
          LOG("[WS] Restarting after unpairing");
          sendGoingOffline();
          webSocket.disconnect();
          delay(1000);
          ESP.restart();
        }
      }

    } else if (message.indexOf("\"type\":\"enable-payment\"") != -1) {
      // Activate payment: power the coin/bill acceptors via relay 1 and start counting pulses.
      paymentEnabled    = true;
      paymentEnableTime = millis(); // Used by ISRs to apply the stabilisation guard
      digitalWrite(RELAY_1_PIN, RELAY_ON); // Relay 1: coin/bill acceptor power rail
      relay1State = true;
      LOG("[PAYMENT] ========== ENABLED ==========");
      LOG("[PAYMENT] Coin and Bill acceptors powered ON");
      wsLog("info", "Payment system enabled");

    } else if (message.indexOf("\"type\":\"disable-payment\"") != -1) {
      // Deactivate payment: cut acceptor power and flush accumulated totals to NVS.
      paymentEnabled = false;
      digitalWrite(RELAY_1_PIN, RELAY_OFF);
      relay1State = false;
      LOG("[PAYMENT] Session totals: Coins=" + String(totalCoinPesos) +
          "P, Bills=" + String(totalBillPesos) + "P");
      if (totalsDirty) {
        // Force an immediate NVS write so totals are preserved even if the device restarts soon.
        prefs.putUInt("totalCoinPesos", totalCoinPesos);
        prefs.putUInt("totalBillPesos", totalBillPesos);
        lastTotalsSave = millis();
        totalsDirty = false;
      }
      wsLog("info", "Payment system disabled");

    } else if (message.indexOf("\"type\":\"relay-control\"") != -1) {
      // Manual relay toggle from the dashboard (used for diagnostics and testing).
      // JSON is parsed with indexOf/substring rather than a JSON library to avoid
      // heap fragmentation from a full deserialisation on every WS message.
      int channelIndex = message.indexOf("\"channel\":");
      int stateIndex   = message.indexOf("\"state\":");
      if (channelIndex != -1 && stateIndex != -1) {
        int channelStart = channelIndex + 10;
        int channelEnd   = message.indexOf(',', channelStart);
        if (channelEnd == -1) channelEnd = message.indexOf('}', channelStart);
        int channel = message.substring(channelStart, channelEnd).toInt();

        int stateStart = stateIndex + 8;
        int stateEnd   = message.indexOf('}', stateStart);
        bool state = (message.substring(stateStart, stateEnd).indexOf("true") != -1);
        if (channel >= 1 && channel <= 8) setRelay(channel, state);
      }

    } else if (message.indexOf("\"type\":\"start-service\"") != -1) {
      // Extract service parameters from the JSON payload using indexOf/substring (see relay-control note).
      int shoeTypeIndex    = message.indexOf("\"shoeType\":\"");
      String shoeType      = (shoeTypeIndex    != -1) ? message.substring(shoeTypeIndex + 12,    message.indexOf("\"", shoeTypeIndex + 12))    : "";
      int serviceTypeIndex = message.indexOf("\"serviceType\":\"");
      String serviceType   = (serviceTypeIndex != -1) ? message.substring(serviceTypeIndex + 15, message.indexOf("\"", serviceTypeIndex + 15)) : "";
      int careTypeIndex    = message.indexOf("\"careType\":\"");
      String careType      = (careTypeIndex    != -1) ? message.substring(careTypeIndex + 12,    message.indexOf("\"", careTypeIndex + 12))    : "";

      // duration: optional custom override in seconds (0 = use service default)
      unsigned long customDuration = 0;
      int durationIndex = message.indexOf("\"duration\":");
      if (durationIndex != -1) {
        int start = durationIndex + 11;
        int end   = message.indexOf(",", start);
        if (end == -1) end = message.indexOf("}", start);
        customDuration = message.substring(start, end).toInt();
      }

      // cleaningDistanceMm: optional custom side-brush travel depth (-1 = use care-level default)
      long customCleaningDistanceMm = -1;
      int distMmIndex = message.indexOf("\"cleaningDistanceMm\":");
      if (distMmIndex != -1) {
        int start = distMmIndex + 21;
        int end   = message.indexOf(",", start);
        if (end == -1) end = message.indexOf("}", start);
        customCleaningDistanceMm = message.substring(start, end).toInt();
      }

      if (serviceType == "cleaning" || serviceType == "drying" || serviceType == "sterilizing") {
        startService(shoeType, serviceType, careType, customDuration, customCleaningDistanceMm);
        wsLog("info", "Service started: " + serviceType + " | shoe: " + shoeType);
      }

    } else if (message.indexOf("\"type\":\"stop-service\"") != -1) {
      // Two cases:
      // 1. Service is active → stopService() ends it (and may start a post-dry/steril purge).
      // 2. Service is idle but purge is running → abortPurgeIfActive() cuts the exhaust fan.
      // Do NOT call abortPurgeIfActive() after stopService(), because stopService() itself
      // starts the purge — calling abort immediately would cancel it before it runs.
      if (serviceActive) {
        stopService("aborted");
      } else {
        abortPurgeIfActive();
      }
      wsLog("info", "Stop service (WS)");

    } else if (message.indexOf("\"type\":\"start-classification\"") != -1) {
      if (camIsReady && camMacPaired) sendClassifyRequest();
      else relayClassificationErrorToBackend("CAM_NOT_READY");

    } else if (message.indexOf("\"type\":\"enable-classification\"") != -1) {
      // Turn on white LEDs for shoe scan preview; CAM LED on for illumination.
      rgbWhite();
      classificationLedOn = true;
      sendLedControl(CAM_MSG_LED_ENABLE);

    } else if (message.indexOf("\"type\":\"disable-classification\"") != -1) {
      classificationLedOn = false;
      if (!serviceActive) rgbOff(); // Only clear LEDs if no service is currently running
      sendLedControl(CAM_MSG_LED_DISABLE);

    } else if (message.indexOf("\"type\":\"restart-device\"") != -1) {
      LOG("[WS] Restart requested by dashboard");
      sendGoingOffline();
      webSocket.disconnect();
      delay(1000);
      ESP.restart();

    } else if (message.indexOf("\"type\":\"serial-command\"") != -1) {
      // Dashboard can inject serial commands remotely — same as typing in the Serial Monitor.
      int cmdIndex = message.indexOf("\"command\":\"");
      if (cmdIndex != -1) {
        String serialCmd = message.substring(cmdIndex + 11, message.indexOf("\"", cmdIndex + 11));
        if (serialCmd.length() > 0) handleSerialCommand(serialCmd);
      }
    }
    break;
  }

  case WStype_ERROR:
    wsConnected = false;
    LOG("[WS] Event: ERROR");
    break;

  // Unused frame types — handled silently to avoid spurious log noise.
  case WStype_BIN:
  case WStype_FRAGMENT_TEXT_START:
  case WStype_FRAGMENT_BIN_START:
  case WStype_FRAGMENT:
  case WStype_FRAGMENT_FIN:
  case WStype_PING:
  case WStype_PONG:
    break;
  }
}

/**
 * Open the WebSocket connection to the backend.
 * Guard: only called once per WiFi connect cycle (wsInitialized prevents duplicate opens).
 *
 * Session query params:
 *   deviceId   — used by the backend to route messages to this device's subscription channel
 *   v=millis() — unique per session; prevents proxies from serving a cached WS handshake
 *   groupToken — optional; backend uses it to validate the device belongs to the right owner
 *
 * enableHeartbeat(15000, 3000, 2):
 *   ping every 15s, expect pong within 3s, disconnect after 2 missed pongs (~36s total)
 */
void connectWebSocket() {
  if (!wifiConnected || wsInitialized) return;

  LOG("[WS] Connecting to backend");
  String wsPath = "/api/ws?deviceId=" + deviceId + "&v=" + String(millis());
  if (groupToken.length() > 0) wsPath += "&groupToken=" + groupToken;

#if USE_LOCAL_BACKEND
  webSocket.begin(BACKEND_HOST, BACKEND_PORT, wsPath);
#else
  webSocket.beginSSL(BACKEND_HOST, BACKEND_PORT, wsPath); // TLS required for production endpoint
#endif
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(WS_RECONNECT_INTERVAL); // 5s between reconnect attempts
  webSocket.enableHeartbeat(15000, 3000, 2); // ping/15s, pong timeout/3s, max missed/2
  wsInitialized = true;
}

void sendGoingOffline() {
  if (!wsConnected || deviceId.length() == 0) return;
  String msg = "{\"type\":\"going-offline\",\"deviceId\":\"" + deviceId + "\"}";
  webSocket.sendTXT(msg);
  // Give TCP a brief window to flush before disconnect/restart.
  delay(150);
}
