/**
 * ===================== WEBSOCKET FUNCTIONS =====================
 *
 * Manages the persistent WebSocket connection to the backend server.
 * All real-time communication between the ESP32 and the web dashboard/kiosk
 * flows through this channel.
 *
 * Inbound message types (from backend/dashboard):
 *   status-ack           — Confirms pairing state from DB
 *   device-update        — Dashboard paired/unpaired the device
 *   enable-payment       — Activate coin/bill acceptors
 *   disable-payment      — Deactivate coin/bill acceptors
 *   relay-control         — Direct relay channel on/off
 *   start-service        — Begin cleaning/drying/sterilizing
 *   start-classification — Trigger shoe classification via CAM
 *   enable-classification / disable-classification — LED + CAM control
 *   restart-device       — Remote reboot
 *   serial-command       — Execute serial command remotely
 *
 * Outbound message types (to backend):
 *   subscribe, status-update, coin-inserted, bill-inserted,
 *   service-status, service-complete, classification-result,
 *   cam-paired, cam-sync-status, firmware-log
 */

// Send a log message to the backend → broadcast to kiosk browser console.
// level: "info", "warn", "error"
void wsLog(const char *level, const String &msg) {
  if (!wsConnected || deviceId.length() == 0) return;

  String safe = msg;
  safe.replace("\\", "\\\\");
  safe.replace("\"", "\\\"");
  safe.replace("\n", "\\n");
  safe.replace("\r", "\\r");

  webSocket.sendTXT("{\"type\":\"firmware-log\",\"deviceId\":\"" + deviceId +
                    "\",\"level\":\"" + String(level) +
                    "\",\"message\":\"" + safe + "\"}");
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {

    case WStype_DISCONNECTED:
      LOG("[WS] Disconnected");
      wsConnected = false;
      break;

    case WStype_CONNECTED:
      LOG("[WS] Connected");
      wsConnected = true;
      webSocket.sendTXT("{\"type\":\"subscribe\",\"deviceId\":\"" + deviceId + "\"}");
      wsLog("info", "WS Connected (firmware v" + String(FIRMWARE_VERSION) + ")");
      break;

    case WStype_TEXT: {
      String message = String((char *)payload);

      if (message.indexOf("\"type\":\"status-ack\"") != -1) {
        bool dbPaired = (message.indexOf("\"paired\":true") != -1);
        if (dbPaired && !isPaired) {
          isPaired = true;
          prefs.putBool("paired", true);
          LOG("[WS] Device paired");
        } else if (!dbPaired && isPaired) {
          isPaired = false;
          prefs.putBool("paired", false);
          pairingCode = generatePairingCode();
          sendDeviceRegistration();
        }

      } else if (message.indexOf("\"type\":\"device-update\"") != -1) {
        if (message.indexOf("\"paired\":true") != -1) {
          if (!isPaired) {
            isPaired = true;
            prefs.putBool("paired", true);
            LOG("[WS] Paired by dashboard");
            wsLog("info", "Device paired by dashboard");
          }
        } else if (message.indexOf("\"paired\":false") != -1) {
          if (isPaired) {
            LOG("[WS] Unpaired — restarting");
            isPaired = false;
            prefs.putBool("paired", false);
            wsLog("warn", "Device unpaired — restarting");
            delay(500);
            ESP.restart();
          }
        }

      } else if (message.indexOf("\"type\":\"enable-payment\"") != -1) {
        LOG("[Payment] Enabled");
        paymentEnabled = true;
        paymentEnableTime = millis();
        digitalWrite(RELAY_1_PIN, RELAY_ON);
        relay1State = true;
        wsLog("info", "Payment system enabled");

      } else if (message.indexOf("\"type\":\"disable-payment\"") != -1) {
        LOG("[Payment] Disabled");
        paymentEnabled = false;
        digitalWrite(RELAY_1_PIN, RELAY_OFF);
        relay1State = false;
        currentCoinPulses = 0;
        currentBillPulses = 0;
        if (totalsDirty) {
          prefs.putUInt("totalCoinPesos", totalCoinPesos);
          prefs.putUInt("totalBillPesos", totalBillPesos);
          lastTotalsSave = millis();
          totalsDirty = false;
        }
        wsLog("info", "Payment system disabled");

      } else if (message.indexOf("\"type\":\"relay-control\"") != -1) {
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

          if (channel >= 1 && channel <= 8) {
            setRelay(channel, state);
          }
        }

      } else if (message.indexOf("\"type\":\"start-service\"") != -1) {
        String shoeType    = "";
        String serviceType = "";
        String careType    = "";

        auto extractField = [&](const String &key) -> String {
          int idx = message.indexOf(key);
          if (idx == -1) return "";
          int start = idx + key.length();
          int end   = message.indexOf("\"", start);
          return message.substring(start, end);
        };

        shoeType    = extractField("\"shoeType\":\"");
        serviceType = extractField("\"serviceType\":\"");
        careType    = extractField("\"careType\":\"");

        unsigned long customDuration = 0;
        int durationIndex = message.indexOf("\"duration\":");
        if (durationIndex != -1) {
          int start = durationIndex + 11;
          int end   = message.indexOf(",", start);
          if (end == -1) end = message.indexOf("}", start);
          customDuration = message.substring(start, end).toInt();
        }

        long customCleaningDistanceMm = -1;
        int distMmIndex = message.indexOf("\"cleaningDistanceMm\":");
        if (distMmIndex != -1) {
          int start = distMmIndex + 21;
          int end   = message.indexOf(",", start);
          if (end == -1) end = message.indexOf("}", start);
          customCleaningDistanceMm = message.substring(start, end).toInt();
        }

        if (serviceType == "cleaning" || serviceType == "drying" ||
            serviceType == "sterilizing") {
          startService(shoeType, serviceType, careType,
                       customDuration, customCleaningDistanceMm);
          wsLog("info", "Service started: " + serviceType + " | shoe: " + shoeType +
                        " | care: " + careType +
                        (customDuration > 0 ? " | " + String(customDuration) + "s" : ""));
        }

      } else if (message.indexOf("\"type\":\"start-classification\"") != -1) {
        LOG("[WS] Classification requested");
        if (camIsReady && camMacPaired) {
          sendClassifyRequest();
        } else {
          LOG("[WS] CAM not ready");
          relayClassificationErrorToBackend("CAM_NOT_READY");
        }

      } else if (message.indexOf("\"type\":\"enable-classification\"") != -1) {
        LOG("[WS] Classification LED ON");
        rgbWhite();
        classificationLedOn = true;
        sendLedControl(CAM_MSG_LED_ENABLE);

      } else if (message.indexOf("\"type\":\"disable-classification\"") != -1) {
        LOG("[WS] Classification LED OFF");
        rgbOff();
        classificationLedOn = false;
        sendLedControl(CAM_MSG_LED_DISABLE);

      } else if (message.indexOf("\"type\":\"restart-device\"") != -1) {
        LOG("[WS] Restart command received");
        delay(2000);
        ESP.restart();

      } else if (message.indexOf("\"type\":\"serial-command\"") != -1) {
        int cmdIndex = message.indexOf("\"command\":\"");
        if (cmdIndex != -1) {
          int cmdStart = cmdIndex + 11;
          int cmdEnd   = message.indexOf("\"", cmdStart);
          if (cmdEnd != -1) {
            String serialCmd = message.substring(cmdStart, cmdEnd);
            serialCmd.trim();
            if (serialCmd.length() > 0 && serialCmd.length() <= 256) {
              wsLog("info", "WS cmd: " + serialCmd);
              handleSerialCommand(serialCmd);
            }
          }
        }
      }
      break;
    }

    case WStype_ERROR:
      LOG("[WS] Error");
      wsConnected = false;
      break;
  }
}

void connectWebSocket() {
  if (!wifiConnected || wsInitialized) return;

  String wsPath = "/api/ws?deviceId=" + deviceId;
  if (groupToken.length() > 0) {
    wsPath += "&groupToken=" + groupToken;
  }

  LOG("[WS] Connecting to " + String(BACKEND_HOST));
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
