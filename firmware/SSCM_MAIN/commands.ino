/**
 * ===================== SYSTEM COMMANDS & OTA =====================
 *
 * factoryReset()      — Clears NVS (WiFi, pairing, totals) and reboots.
 * setupOTA()          — Initializes Over-The-Air firmware updates.
 * handleSerialCommand — Master parser for incoming text commands.
 *
 * Commands can originate from the physical USB Serial Monitor OR via
 * the WebSocket 'serial-command' event from the dashboard / admin panel.
 *
 * Supported commands:
 *   RESET_WIFI, RESET_PAIRING, RESET_MONEY, FACTORY_RESET, STATUS
 *   RELAY_<channel>_<ON|OFF>, RELAY_ALL_OFF
 *   SERVO_DEMO, SERVO_STATUS, SERVO_<angle>
 *   MOTOR_<LEFT|RIGHT>_<SPEED|BRAKE|COAST>
 *   STEPPER1_<HOME|RETURN|STOP|SPEED|MOVE|GOTO|MM>
 *   RGB_<COLOR>
 *   CAM_<BROADCAST|CLASSIFY>
 */

void factoryReset() {
  LOG("[RESET] Factory reset triggered");
  allRelaysOff();
  wsLog("warn", "Factory reset triggered — final totals: Coin PHP" +
                String(totalCoinPesos) + ", Bill PHP" +
                String(totalBillPesos) + ", Total PHP" + String(totalPesos));

  if (espNowInitialized && camMacPaired) {
    CamMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.type = CAM_MSG_FACTORY_RESET;
    for (int i = 0; i < 3; i++) {
      esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
      delay(500);
    }
    delay(1000);
  }

  prefs.clear();
  LOG("[RESET] NVS cleared — restarting");
  delay(500);
  ESP.restart();
}

/* ===================== OTA UPDATE ===================== */

void setupOTA() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char hostname[24];
  snprintf(hostname, sizeof(hostname), "sscm-main-%02X%02X", mac[4], mac[5]);
  ArduinoOTA.setHostname(hostname);
  ArduinoOTA.setPassword(groupToken.length() == 8 ? groupToken.c_str() : "SSCM-OTA");

  ArduinoOTA.onStart([]() {
    allRelaysOff();
    LOG("[OTA] Update started");
    wsLog("warn", "OTA firmware update started");
  });
  ArduinoOTA.onEnd([]() {
    LOG("[OTA] Complete — restarting");
    wsLog("info", "OTA update complete");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {});
  ArduinoOTA.onError([](ota_error_t error) {
    LOG("[OTA] Error: " + String(error));
    wsLog("error", "OTA failed: " + String(error));
  });
  ArduinoOTA.begin();
  LOG("[OTA] Ready: " + String(hostname));
}

/* ===================== SERIAL / WS COMMAND HANDLER ===================== */

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  LOG(">> " + cmd);

  if (cmd == "RESET_WIFI") {
    prefs.remove("ssid");
    prefs.remove("pass");
    delay(1000);
    ESP.restart();

  } else if (cmd == "RESET_PAIRING") {
    prefs.putBool("paired", false);
    isPaired = false;
    pairingCode = generatePairingCode();
    delay(1000);
    ESP.restart();

  } else if (cmd == "RESET_MONEY") {
    totalCoinPesos = 0;
    totalBillPesos = 0;
    totalPesos     = 0;
    currentCoinPulses = 0;
    currentBillPulses = 0;
    prefs.putUInt("totalCoinPesos", 0);
    prefs.putUInt("totalBillPesos", 0);
    LOG("[CMD] Money reset");

  } else if (cmd == "FACTORY_RESET") {
    factoryReset();

  } else if (cmd == "STATUS") {
    LOG("=== STATUS ===");
    LOG("Device:  " + deviceId);
    LOG("WiFi:    " + String(wifiConnected ? WiFi.localIP().toString() : "Disconnected"));
    LOG("WS:      " + String(wsConnected ? "Connected" : "Disconnected"));
    LOG("Paired:  " + String(isPaired ? "Yes" : "No, code=" + pairingCode));
    LOG("Money:   PHP" + String(totalPesos) + " (C:" + String(totalCoinPesos) + " B:" + String(totalBillPesos) + ")");
    LOG("Temp:    " + String(currentTemperature, 1) + "C  Hum: " + String(currentHumidity, 1) + "%");
    LOG("S1: " + String(currentStepper1Position) + (stepper1Moving ? " MOVING" : ""));
    LOG("S2: " + String(currentStepper2Position) + (stepper2Moving ? " MOVING" : ""));
    LOG("Heap:    " + String(ESP.getFreeHeap() / 1024) + "KB (min " + String(ESP.getMinFreeHeap() / 1024) + "KB)");
    LOG("CAM:     " + String(camIsReady ? "Ready" : "Not Ready") + " MAC:" + String(camMacPaired ? "Y" : "N"));
    LOG("==============");

  } else if (cmd.startsWith("RELAY")) {
    if (cmd == "RELAY_ALL_OFF") {
      allRelaysOff();
    } else {
      int u1 = cmd.indexOf('_');
      int u2 = cmd.indexOf('_', u1 + 1);
      if (u1 != -1 && u2 != -1) {
        int channel = cmd.substring(u1 + 1, u2).toInt();
        String action = cmd.substring(u2 + 1);
        if (channel >= 1 && channel <= 8) {
          if      (action == "ON")  setRelay(channel, true);
          else if (action == "OFF") setRelay(channel, false);
        }
      }
    }

  } else if (cmd == "SERVO_DEMO") {
    const int demoAngles[] = {0, 90, 180, 0};
    for (int i = 0; i < 4; i++) {
      setServoPositions(demoAngles[i], true);
      unsigned long t = millis();
      while (servosMoving && millis() - t < 3000) {
        updateServoPositions();
        delay(1);
      }
    }
    LOG("[CMD] Servo demo done");

  } else if (cmd == "SERVO_STATUS") {
    LOG("[Servo] L:" + String(currentLeftPosition) + " R:" + String(currentRightPosition) +
        " Moving:" + String(servosMoving));

  } else if (cmd.startsWith("SERVO_DIRECT_")) {
    int angle = constrain(cmd.substring(13).toInt(), 0, 180);
    servoLeft.write(angle);
    servoRight.write(180 - angle);
    currentLeftPosition  = angle;
    currentRightPosition = 180 - angle;
    targetLeftPosition   = angle;
    targetRightPosition  = 180 - angle;
    servosMoving = false;

  } else if (cmd.startsWith("SERVO_")) {
    int angle = cmd.substring(6).toInt();
    if (angle >= 0 && angle <= 180) setServoPositions(angle, true);

  } else if (cmd.startsWith("MOTOR_LEFT_")) {
    String sub = cmd.substring(11);
    if      (sub == "BRAKE")              leftMotorBrake();
    else if (sub == "COAST" || sub == "STOP") leftMotorCoast();
    else {
      int speed = sub.toInt();
      if (speed >= -255 && speed <= 255) setLeftMotorSpeed(speed);
    }

  } else if (cmd.startsWith("MOTOR_RIGHT_")) {
    String sub = cmd.substring(12);
    if      (sub == "BRAKE")              rightMotorBrake();
    else if (sub == "COAST" || sub == "STOP") rightMotorCoast();
    else {
      int speed = sub.toInt();
      if (speed >= -255 && speed <= 255) setRightMotorSpeed(speed);
    }

  } else if (cmd.startsWith("MOTOR_")) {
    String sub = cmd.substring(6);
    if      (sub == "BRAKE")              motorsBrake();
    else if (sub == "COAST" || sub == "STOP") motorsCoast();
    else {
      int speed = sub.toInt();
      if (speed >= -255 && speed <= 255) setMotorsSameSpeed(speed);
    }

  } else if (cmd.startsWith("STEPPER1_")) {
    String sub = cmd.substring(9);
    if      (sub == "STOP")   stepper1Stop();
    else if (sub == "HOME")   stepper1Home();
    else if (sub == "RETURN") stepper1MoveTo(CLEANING_MAX_POSITION);
    else if (sub == "INFO")   wsLog("info", "S1 pos=" + String(currentStepper1Position) +
                                    " spd=" + String(stepper1Speed) +
                                    (stepper1Moving ? " MOVING" : " IDLE"));
    else if (sub == "TEST_MANUAL") {
      for (int i = 0; i < 10; i++) {
        digitalWrite(STEPPER1_DIR_PIN, HIGH);
        delayMicroseconds(5);
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
        delayMicroseconds(20);
        digitalWrite(STEPPER1_STEP_PIN, LOW);
        delayMicroseconds(20);
      }
    } else if (sub == "TEST_PINS") {
      for (int i = 0; i < 10; i++) {
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
        delayMicroseconds(100);
        digitalWrite(STEPPER1_STEP_PIN, LOW);
        delayMicroseconds(100);
      }
    } else if (sub == "TEST_PULSE") {
      for (int i = 0; i < 100; i++) {
        digitalWrite(STEPPER1_STEP_PIN, HIGH);
        delayMicroseconds(20);
        digitalWrite(STEPPER1_STEP_PIN, LOW);
        delayMicroseconds(980);
      }
    } else if (sub.startsWith("SPEED_")) {
      int speed = sub.substring(6).toInt();
      if (speed > 0 && speed <= 800) setStepper1Speed(speed);
    } else if (sub.startsWith("MOVE_"))  stepper1MoveRelative(sub.substring(5).toInt());
    else if (sub.startsWith("GOTO_"))    stepper1MoveTo(sub.substring(5).toInt());
    else if (sub.startsWith("MM_"))      stepper1MoveByMM(sub.substring(3).toFloat());

  } else if (cmd.startsWith("STEPPER2_")) {
    String sub = cmd.substring(9);
    if      (sub == "STOP")   stepper2Stop();
    else if (sub == "HOME")   stepper2Home();
    else if (sub == "RETURN") stepper2MoveTo(0);
    else if (sub == "INFO")   wsLog("info", "S2 pos=" + String(currentStepper2Position) +
                                    " spd=" + String(stepper2Speed) +
                                    (stepper2Moving ? " MOVING" : " IDLE"));
    else if (sub.startsWith("SPEED_")) {
      int speed = sub.substring(6).toInt();
      if (speed > 0 && speed <= STEPPER2_MAX_SPEED) setStepper2Speed(speed);
    } else if (sub.startsWith("MOVE_"))  stepper2MoveRelative(sub.substring(5).toInt());
    else if (sub.startsWith("GOTO_"))    stepper2MoveTo(sub.substring(5).toInt());
    else if (sub.startsWith("MM_"))      stepper2MoveByMM(sub.substring(3).toFloat());

  } else if (cmd.startsWith("RGB_")) {
    String sub = cmd.substring(4);
    if      (sub == "WHITE")  rgbWhite();
    else if (sub == "BLUE")   rgbBlue();
    else if (sub == "GREEN")  rgbGreen();
    else if (sub == "VIOLET") rgbViolet();
    else if (sub == "OFF")    rgbOff();
    else if (sub.startsWith("CUSTOM_")) {
      String rgb = sub.substring(7);
      int u1 = rgb.indexOf('_');
      int u2 = rgb.indexOf('_', u1 + 1);
      if (u1 > 0 && u2 > u1) {
        setRGBColor(rgb.substring(0, u1).toInt(),
                    rgb.substring(u1 + 1, u2).toInt(),
                    rgb.substring(u2 + 1).toInt());
      }
    }

  } else if (cmd.startsWith("CAM_")) {
    String sub = cmd.substring(4);
    if      (sub == "BROADCAST") sendPairingBroadcast();
    else if (sub == "CLASSIFY")  sendClassifyRequest();

  } else {
    LOG("[CMD] Unknown: " + cmd);
  }
}
