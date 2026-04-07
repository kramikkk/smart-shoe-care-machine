/* ===================== FACTORY RESET ===================== */

void factoryReset() {
  allRelaysOff();
  wsLog("warn", "Factory reset triggered — final totals: Coin ₱" +
                String(totalCoinPesos) + ", Bill ₱" +
                String(totalBillPesos) + ", Total ₱" + String(totalPesos));

  // Notify CAM before wiping our own prefs
  if (espNowInitialized && camMacPaired) {
    CamMessage msg;
    memset(&msg, 0, sizeof(msg));
    msg.type = CAM_MSG_FACTORY_RESET;
    for (int i = 0; i < 3; i++) { // Send 3× for reliability (fire-and-forget)
      esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
      delay(500);
    }
    delay(1000);
  }

  prefs.clear();
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
    wsLog("warn", "OTA firmware update started — device will restart");
  });
  ArduinoOTA.onEnd([]() {
    wsLog("info", "OTA update complete — restarting now");
  });
  ArduinoOTA.onError([](ota_error_t error) {
    wsLog("error", "OTA update failed — error code: " + String(error));
  });
  ArduinoOTA.begin();
}

/* ===================== SERIAL / WS COMMAND HANDLER ===================== */

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

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

  } else if (cmd == "FACTORY_RESET") {
    factoryReset();

  } else if (cmd == "STATUS") {
    wsLog("info", "Device: " + deviceId);
    wsLog("info", "WiFi: " + String(wifiConnected ? WiFi.localIP().toString() : "Disconnected"));
    wsLog("info", "WS: " + String(wsConnected ? "OK" : "Down"));
    wsLog("info", "Paired: " + String(isPaired ? "Yes" : pairingCode));
    wsLog("info", "Money: " + String(totalPesos) + " PHP");
    wsLog("info", "Temp: " + String(currentTemperature) + "C, Humidity: " + String(currentHumidity) + "%");
    wsLog("info", "Stepper1: " + String(currentStepper1Position / 10.0) + "mm" + (stepper1Moving ? " (moving)" : ""));
    wsLog("info", "Stepper2: " + String(currentStepper2Position / 200.0) + "mm" + (stepper2Moving ? " (moving)" : ""));
    wsLog("info", "Heap: " + String(ESP.getFreeHeap() / 1024) + " KB (" + String(ESP.getMinFreeHeap() / 1024) + " KB min)");

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

  } else if (cmd == "SERVO_STATUS") {
    Serial.println("[Servo] Left: " + String(currentLeftPosition) +
                   "° Right: " + String(currentRightPosition) +
                   "° | Moving: " + String(servosMoving) +
                   " | Target L: " + String(targetLeftPosition) +
                   "° R: " + String(targetRightPosition) + "°");
    Serial.println("[Servo] Attached L:" + String(servoLeft.attached()) +
                   " R:" + String(servoRight.attached()));

  } else if (cmd.startsWith("SERVO_DIRECT_")) {
    int angle = constrain(cmd.substring(13).toInt(), 0, 180);
    servoLeft.write(angle);
    servoRight.write(180 - angle);
    currentLeftPosition  = angle;
    currentRightPosition = 180 - angle;
    targetLeftPosition   = angle;
    targetRightPosition  = 180 - angle;
    servosMoving = false;
    Serial.println("[Servo] DIRECT write L:" + String(angle) + "° R:" + String(180 - angle) + "°");

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
  }
}
