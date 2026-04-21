/**
 * Command Handling
 * Parser for serial monitor and remote (dashboard serial-command WS message) commands.
 * Used for manual control, diagnostics, and in-field testing without reflashing.
 *
 * Available commands:
 *   RESET_WIFI              — Erase stored WiFi credentials and restart (triggers SoftAP setup portal)
 *   RESET_PAIRING           — Clear paired flag, generate fresh pairing code, restart
 *   RESET_MONEY             — Zero all accumulated payment totals in RAM and NVS
 *   QUERY_MONEY             — Send current coin/bill/total pesos as structured money-status WS message
 *   FACTORY_RESET           — Full factory reset (WiFi, pairing, CAM, NVS cleared; restart)
 *   STATUS                  — Dump device state to backend firmware log
 *   RELAY_ALL_OFF           — Cut all relay channels
 *   RELAY_<N>_ON/OFF        — Toggle relay channel N (1–8)
 *   SERVO_DEMO              — Run a 4-point demo sweep (0→90→180→0°)
 *   SERVO_STATUS            — Print current servo positions to Serial
 *   SERVO_DIRECT_<deg>      — Instant write to servo (bypasses smooth movement)
 *   SERVO_<deg>             — Smooth move to angle (0–180°)
 *   MOTOR_LEFT_<speed|BRAKE|COAST|STOP>   — Control left brush motor
 *   MOTOR_RIGHT_<speed|BRAKE|COAST|STOP>  — Control right brush motor
 *   MOTOR_<speed|BRAKE|COAST|STOP>        — Control both motors together
 *   STEPPER1_STOP/HOME/RETURN/INFO        — Top brush stepper: stop, home (zero), return to park, log pos
 *   STEPPER1_SPEED_<sps>                  — Set steps-per-second
 *   STEPPER1_MOVE_<steps>                 — Relative move by N steps
 *   STEPPER1_GOTO_<steps>                 — Absolute move to step position
 *   STEPPER1_MM_<mm>                      — Relative move by N mm (×10 steps/mm)
 *   STEPPER2_* (same sub-commands as STEPPER1, ×200 steps/mm)
 *   RGB_WHITE/BLUE/GREEN/VIOLET/OFF       — Set LED strip colour
 *   RGB_CUSTOM_<r>_<g>_<b>               — Set arbitrary RGB (0–255 per channel)
 *   CAM_BROADCAST                         — Re-trigger ESP-NOW pairing broadcast
 *   CAM_CLASSIFY                          — Send classify request to CAM
 */
void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "RESET_WIFI") {
    // Erase WiFi credentials from NVS; restart will land in SoftAP setup portal.
    prefs.remove("ssid");
    prefs.remove("pass");
    delay(1000);
    ESP.restart();
  } else if (cmd == "RESET_PAIRING") {
    // Clear local pairing + CAM pairing metadata, then restart in an unpaired state.
    prefs.putBool("paired", false);
    prefs.remove("camDeviceId");
    prefs.remove("camIp");
    prefs.remove("camMac");
    isPaired = false;
    camMacPaired = false;
    pairedCamDeviceId = "";
    pairedCamIp = "";
    memset(camMacAddress, 0, sizeof(camMacAddress));
    pairingCode = generatePairingCode();
    wsLog("warn", "Pairing reset requested — restarting as unpaired device");
    delay(1000);
    ESP.restart();
  } else if (cmd == "RESET_MONEY") {
    // Zero all payment accumulators in RAM and flush immediately to NVS.
    totalCoinPesos = 0;
    totalBillPesos = 0;
    totalPesos = 0;
    currentCoinPulses = 0;
    currentBillPulses = 0;
    prefs.putUInt("totalCoinPesos", 0);
    prefs.putUInt("totalBillPesos", 0);
    wsLog("info", "Money counters reset — Coins: 0, Bills: 0, Total: 0 PHP");
  } else if (cmd == "QUERY_MONEY") {
    // Log current coin/bill totals to the dashboard live response log.
    wsLog("info", "Coins: " + String(totalCoinPesos) + " PHP");
    wsLog("info", "Bills: " + String(totalBillPesos) + " PHP");
    wsLog("info", "Total: " + String(totalPesos) + " PHP");
  } else if (cmd == "FACTORY_RESET") {
    factoryReset(); // Clears all NVS keys, resets CAM, restarts
  } else if (cmd == "STATUS") {
    // Diagnostic snapshot sent to the backend firmware log (visible on owner dashboard).
    // Stepper positions converted from raw steps: Stepper1 ÷10 = mm, Stepper2 ÷200 = mm.
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
      // Parse format: RELAY_<channel>_<ON|OFF>  e.g. "RELAY_3_ON"
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
    // Run a 4-point sweep: 0°→90°→180°→0° in fast mode; blocks up to 3s per move.
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
    // Bypass the smooth step-interpolation and write the angle to the servo hardware immediately.
    // Useful for quick diagnostics when interpolation speed is not needed.
    String angleStr = cmd.substring(13);
    int angle = constrain(angleStr.toInt(), 0, 180);
    servoLeft.write(angle);
    servoRight.write(180 - angle); // Right servo mirrors left (180° - angle)
    currentLeftPosition = angle;
    currentRightPosition = 180 - angle;
    targetLeftPosition = angle;
    targetRightPosition = 180 - angle;
    servosMoving = false;
  } else if (cmd.startsWith("SERVO_")) {
    String angleStr = cmd.substring(6);
    int angle = angleStr.toInt();
    if (angle >= 0 && angle <= 180) setServoPositions(angle, true); // Smooth move in fast mode
  } else if (cmd.startsWith("MOTOR_LEFT_")) {
    // Left brush DC motor: speed -255 to +255 (negative = reverse), BRAKE = both IN HIGH, COAST = both IN LOW.
    String subCmd = cmd.substring(11);
    if (subCmd == "BRAKE") leftMotorBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") leftMotorCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setLeftMotorSpeed(speed);
    }
  } else if (cmd.startsWith("MOTOR_RIGHT_")) {
    // Right brush DC motor: same interface as left motor.
    String subCmd = cmd.substring(12);
    if (subCmd == "BRAKE") rightMotorBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") rightMotorCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setRightMotorSpeed(speed);
    }
  } else if (cmd.startsWith("MOTOR_")) {
    // Both brush motors at the same speed/state simultaneously.
    String subCmd = cmd.substring(6);
    if (subCmd == "BRAKE") motorsBrake();
    else if (subCmd == "COAST" || subCmd == "STOP") motorsCoast();
    else {
      int speed = subCmd.toInt();
      if (speed >= -255 && speed <= 255) setMotorsSameSpeed(speed);
    }
  } else if (cmd.startsWith("STEPPER1_")) {
    // Top brush stepper (lead screw 2mm/rev, 10 steps/mm, 0–4800 steps = 0–48mm).
    // HOME zeros the position counter; RETURN parks at CLEANING_MAX_POSITION (4800 steps / 48mm).
    String subCmd = cmd.substring(9);
    if (subCmd == "STOP") stepper1Stop();
    else if (subCmd == "HOME") stepper1Home();
    else if (subCmd == "RETURN") stepper1MoveTo(CLEANING_MAX_POSITION); // Park at top (480mm = 4800 steps)
    else if (subCmd == "INFO") wsLog("info", "S1 pos=" + String(currentStepper1Position));
    else if (subCmd.startsWith("SPEED_")) setStepper1Speed(subCmd.substring(6).toInt());
    else if (subCmd.startsWith("MOVE_")) stepper1MoveRelative(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("GOTO_")) stepper1MoveTo(subCmd.substring(5).toInt());
    else if (subCmd.startsWith("MM_")) stepper1MoveByMM(subCmd.substring(3).toFloat());
  } else if (cmd.startsWith("STEPPER2_")) {
    // Side brush stepper (lead screw 1mm/rev, 200 steps/mm, 0–20000 steps = 0–100mm).
    // HOME zeros position; RETURN parks at 0 (retracted position).
    String subCmd = cmd.substring(9);
    if (subCmd == "STOP") stepper2Stop();
    else if (subCmd == "HOME") stepper2Home();
    else if (subCmd == "RETURN") stepper2MoveTo(0); // Retract to home position
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
      // RGB_CUSTOM_<r>_<g>_<b>: parse three underscore-delimited 0–255 values.
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
    if (subCmd == "BROADCAST") sendPairingBroadcast(); // Re-trigger ESP-NOW pairing search
    else if (subCmd == "CLASSIFY") sendClassifyRequest(); // Send classify request to CAM over ESP-NOW
  }
}
