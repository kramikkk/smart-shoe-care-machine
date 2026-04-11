/**
 * WebSocket & Backend Communication
 * Handles real-time status updates, command reception, and device registration.
 */

void wsLog(const char *level, const String &msg) {
  if (!wsConnected || deviceId.length() == 0)
    return;
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

void sendDeviceRegistration() {
  if (WiFi.status() != WL_CONNECTED)
    return;

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
    String subMsg =
        "{\"type\":\"subscribe\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(subMsg);
    wsLog("info", "WS Connected (firmware v" + String(FIRMWARE_VERSION) + ")");

    // Immediate status update so backend marks device online right away.
    String statusMsg = "{\"type\":\"status-update\",\"deviceId\":\"" +
                       deviceId +
                       "\",\"camSynced\":" + (camIsReady ? "true" : "false") +
                       ",\"isPaired\":" + (isPaired ? "true" : "false") + "}";
    webSocket.sendTXT(statusMsg);
    lastStatusUpdate = millis();
    break;
  }

  case WStype_TEXT: {
    String message = String((char *)payload);

    if (message.indexOf("\"type\":\"status-ack\"") != -1) {
      bool dbPaired = (message.indexOf("\"paired\":true") != -1);
      if (dbPaired && !isPaired) {
        isPaired = true;
        prefs.putBool("paired", true);
        LOG("[PAIRING] Device paired by backend");
      } else if (!dbPaired && isPaired) {
        isPaired = false;
        prefs.putBool("paired", false);
        LOG("[PAIRING] Device unpaired by backend");
        pairingCode = generatePairingCode();
        sendDeviceRegistration();
      }
    } else if (message.indexOf("\"type\":\"device-update\"") != -1) {
      if (message.indexOf("\"paired\":true") != -1) {
        if (!isPaired) {
          isPaired = true;
          prefs.putBool("paired", true);
          wsLog("info", "Device paired by dashboard");
        }
      } else if (message.indexOf("\"paired\":false") != -1) {
        if (isPaired) {
          isPaired = false;
          prefs.putBool("paired", false);
          wsLog("warn", "Device unpaired — restarting");
          LOG("[WS] Global restart requested");
          sendGoingOffline();
          webSocket.disconnect();
          delay(1000);
          ESP.restart();
        }
      }
    } else if (message.indexOf("\"type\":\"enable-payment\"") != -1) {
      paymentEnabled = true;
      paymentEnableTime = millis();
      digitalWrite(RELAY_1_PIN, RELAY_ON);
      relay1State = true;
      LOG("[PAYMENT] ========== ENABLED ==========");
      LOG("[PAYMENT] Coin and Bill acceptors powered ON");
      wsLog("info", "Payment system enabled");
    } else if (message.indexOf("\"type\":\"disable-payment\"") != -1) {
      paymentEnabled = false;
      digitalWrite(RELAY_1_PIN, RELAY_OFF);
      relay1State = false;
      LOG("[PAYMENT] Session totals: Coins=" + String(totalCoinPesos) +
          "P, Bills=" + String(totalBillPesos) + "P");
      if (totalsDirty) {
        prefs.putUInt("totalCoinPesos", totalCoinPesos);
        prefs.putUInt("totalBillPesos", totalBillPesos);
        lastTotalsSave = millis();
        totalsDirty = false;
      }
      wsLog("info", "Payment system disabled");
    } else if (message.indexOf("\"type\":\"relay-control\"") != -1) {
       // Parsing logic is quite long, I'll keep it as is from the main file.
       // Note: There was a minor logic bug in the original file (channelIndex was used but not defined in that snippet)
       // I'll ensure I copy it correctly.
       int channelIndex = message.indexOf("\"channel\":");
       int stateIndex = message.indexOf("\"state\":");
       if (channelIndex != -1 && stateIndex != -1) {
         int channelStart = channelIndex + 10;
         int channelEnd = message.indexOf(',', channelStart);
         if (channelEnd == -1) channelEnd = message.indexOf('}', channelStart);
         int channel = message.substring(channelStart, channelEnd).toInt();
         
         int stateStart = stateIndex + 8;
         int stateEnd = message.indexOf('}', stateStart);
         bool state = (message.substring(stateStart, stateEnd).indexOf("true") != -1);
         if (channel >= 1 && channel <= 8) setRelay(channel, state);
       }
    } else if (message.indexOf("\"type\":\"start-service\"") != -1) {
       int shoeTypeIndex = message.indexOf("\"shoeType\":\"");
       String shoeType = (shoeTypeIndex != -1) ? message.substring(shoeTypeIndex + 12, message.indexOf("\"", shoeTypeIndex + 12)) : "";
       int serviceTypeIndex = message.indexOf("\"serviceType\":\"");
       String serviceType = (serviceTypeIndex != -1) ? message.substring(serviceTypeIndex + 15, message.indexOf("\"", serviceTypeIndex + 15)) : "";
       int careTypeIndex = message.indexOf("\"careType\":\"");
       String careType = (careTypeIndex != -1) ? message.substring(careTypeIndex + 12, message.indexOf("\"", careTypeIndex + 12)) : "";
       
       unsigned long customDuration = 0;
       int durationIndex = message.indexOf("\"duration\":");
       if (durationIndex != -1) {
         int start = durationIndex + 11;
         int end = message.indexOf(",", start);
         if (end == -1) end = message.indexOf("}", start);
         customDuration = message.substring(start, end).toInt();
       }
       
       long customCleaningDistanceMm = -1;
       int distMmIndex = message.indexOf("\"cleaningDistanceMm\":");
       if (distMmIndex != -1) {
         int start = distMmIndex + 21;
         int end = message.indexOf(",", start);
         if (end == -1) end = message.indexOf("}", start);
         customCleaningDistanceMm = message.substring(start, end).toInt();
       }

       if (serviceType == "cleaning" || serviceType == "drying" || serviceType == "sterilizing") {
         startService(shoeType, serviceType, careType, customDuration, customCleaningDistanceMm);
         wsLog("info", "Service started: " + serviceType + " | shoe: " + shoeType);
       }
    } else if (message.indexOf("\"type\":\"stop-service\"") != -1) {
      // Active service → stopService (may start purge for dry/steril). Idle + purge only
      // → abort purge; do not call abortPurgeIfActive after stopService or we'd cancel
      // the purge that stopService just started.
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
      rgbWhite();
      classificationLedOn = true;
      sendLedControl(CAM_MSG_LED_ENABLE);
    } else if (message.indexOf("\"type\":\"disable-classification\"") != -1) {
      classificationLedOn = false;
      if (!serviceActive)
        rgbOff();
      sendLedControl(CAM_MSG_LED_DISABLE);
    } else if (message.indexOf("\"type\":\"restart-device\"") != -1) {
      LOG("[WS] Global restart requested");
      sendGoingOffline();
      webSocket.disconnect();
      delay(1000);
      ESP.restart();
    } else if (message.indexOf("\"type\":\"serial-command\"") != -1) {
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

  case WStype_BIN:
    break;

  case WStype_FRAGMENT_TEXT_START:
    break;

  case WStype_FRAGMENT_BIN_START:
    break;

  case WStype_FRAGMENT:
    break;

  case WStype_FRAGMENT_FIN:
    break;

  case WStype_PING:
    break;

  case WStype_PONG:
    break;
  }
}

void connectWebSocket() {
  if (!wifiConnected || wsInitialized) return;

  LOG("[WS] Connecting to backend");
  // Add a unique session query param to avoid stale proxy/session reuse.
  String wsPath = "/api/ws?deviceId=" + deviceId + "&v=" + String(millis());
  if (groupToken.length() > 0) wsPath += "&groupToken=" + groupToken;

#if USE_LOCAL_BACKEND
  webSocket.begin(BACKEND_HOST, BACKEND_PORT, wsPath);
#else
  webSocket.beginSSL(BACKEND_HOST, BACKEND_PORT, wsPath);
#endif
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(WS_RECONNECT_INTERVAL);
  webSocket.enableHeartbeat(15000, 3000, 2);
  wsInitialized = true;
}

void sendGoingOffline() {
  if (!wsConnected || deviceId.length() == 0) return;
  String msg = "{\"type\":\"going-offline\",\"deviceId\":\"" + deviceId + "\"}";
  webSocket.sendTXT(msg);
  // Give TCP a brief window to flush before disconnect/restart.
  delay(150);
}
