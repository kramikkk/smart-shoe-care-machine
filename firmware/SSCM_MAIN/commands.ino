/**
 * Command Handling
 * Parser for serial and backend commands for manual control and testing.
 */

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
    totalPesos = 0;
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
      int firstUnderscore = cmd.indexOf('_');
      int secondUnderscore = cmd.indexOf('_', firstUnderscore + 1);
      if (firstUnderscore != -1 && secondUnderscore != -1) {
        String channelStr = cmd.substring(firstUnderscore + 1, secondUnderscore);
        String action = cmd.substring(secondUnderscore + 1);
        int channel = channelStr.toInt();
        if (channel >= 1 && channel <= 8) {
          if (action == "ON") setRelay(channel, true);
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
    Serial.println("[Servo] Left: " + String(currentLeftPosition) + "° Right: " + String(currentRightPosition) + "°");
  } else if (cmd.startsWith("SERVO_DIRECT_")) {
    String angleStr = cmd.substring(13);
    int angle = constrain(angleStr.toInt(), 0, 180);
    servoLeft.write(angle);
    servoRight.write(180 - angle);
    currentLeftPosition = angle;
    currentRightPosition = 180 - angle;
    targetLeftPosition = angle;
    targetRightPosition = 180 - angle;
    servosMoving = false;
  } else if (cmd.startsWith("SERVO_")) {
    String angleStr = cmd.substring(6);
    int angle = angleStr.toInt();
    if (angle >= 0 && angle <= 180) setServoPositions(angle, true);
  } else if (cmd.startsWith("MOTOR_LEFT_")) {
    String subCmd = cmd.substring(11);
    if (subCmd == "BRAKE") leftMotorBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") leftMotorCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setLeftMotorSpeed(speed);
    }
  } else if (cmd.startsWith("MOTOR_RIGHT_")) {
    String subCmd = cmd.substring(12);
    if (subCmd == "BRAKE") rightMotorBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") rightMotorCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setRightMotorSpeed(speed);
    }
  } else if (cmd.startsWith("MOTOR_")) {
    String subCmd = cmd.substring(6);
    if (subCmd == "BRAKE") motorsBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") motorsCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setMotorsSameSpeed(speed);
    }
  } else if (cmd.startsWith("STEPPER1_")) {
    String subCmd = cmd.substring(9);
    if (subCmd == "STOP") stepper1Stop();
    else if (subCmd == "HOME") stepper1Home();
    else if (subCmd == "RETURN") stepper1MoveTo(CLEANING_MAX_POSITION);
    else if (subCmd == "INFO") wsLog("info", "S1 pos=" + String(currentStepper1Position));
    else if (subCmd.startsWith("SPEED_")) setStepper1Speed(subCmd.substring(6).toInt());
    else if (subCmd.startsWith("MOVE_")) stepper1MoveRelative(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("GOTO_")) stepper1MoveTo(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("MM_")) stepper1MoveByMM(subCmd.substring(3).toFloat());
  } else if (cmd.startsWith("STEPPER2_")) {
    String subCmd = cmd.substring(9);
    if (subCmd == "STOP") stepper2Stop();
    else if (subCmd == "HOME") stepper2Home();
    else if (subCmd == "RETURN") stepper2MoveTo(0);
    else if (subCmd == "INFO") wsLog("info", "S2 pos=" + String(currentStepper2Position));
    else if (subCmd.startsWith("SPEED_")) setStepper2Speed(subCmd.substring(6).toInt());
    else if (subCmd.startsWith("MOVE_")) stepper2MoveRelative(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("GOTO_")) stepper2MoveTo(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("MM_")) stepper2MoveByMM(subCmd.substring(3).toFloat());
  } else if (cmd.startsWith("RGB_")) {
    String subCmd = cmd.substring(4);
    if (subCmd == "WHITE") rgbWhite();
    else if (subCmd == "BLUE") rgbBlue();
    else if (subCmd == "GREEN") rgbGreen();
    else if (subCmd == "VIOLET") rgbViolet();
    else if (subCmd == "OFF") rgbOff();
    else if (subCmd.startsWith("CUSTOM_")) {
      // RGB_CUSTOM_r_g_b (matches dashboard serial-command)
      String rest = subCmd.substring(7);
      int u1 = rest.indexOf('_');
      int u2 = rest.indexOf('_', u1 + 1);
      if (u1 > 0 && u2 > u1) {
        int r = rest.substring(0, u1).toInt();
        int g = rest.substring(u1 + 1, u2).toInt();
        int b = rest.substring(u2 + 1).toInt();
        if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255)
          setRGBColor(r, g, b);
      }
    }
  } else if (cmd.startsWith("CAM_")) {
    String subCmd = cmd.substring(4);
    if (subCmd == "BROADCAST") sendPairingBroadcast();
    else if (subCmd == "CLASSIFY") sendClassifyRequest();
  }
}
