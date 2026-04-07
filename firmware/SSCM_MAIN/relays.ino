/* ===================== RELAY CONTROL ===================== */

void setRelay(int channel, bool state) {
  int pin;
  bool *stateVar;

  switch (channel) {
    case 1: pin = RELAY_1_PIN; stateVar = &relay1State; break;
    case 2: pin = RELAY_2_PIN; stateVar = &relay2State; break;
    case 3: pin = RELAY_3_PIN; stateVar = &relay3State; break;
    case 4: pin = RELAY_4_PIN; stateVar = &relay4State; break;
    case 5: pin = RELAY_5_PIN; stateVar = &relay5State; break;
    case 6: pin = RELAY_6_PIN; stateVar = &relay6State; break;
    case 7: pin = RELAY_7_PIN; stateVar = &relay7State; break;
    case 8: pin = RELAY_8_PIN; stateVar = &relay8State; break;
    default: return;
  }

  *stateVar = state;
  digitalWrite(pin, state ? RELAY_ON : RELAY_OFF);

  // Relay 1 switching creates inductive EMI that can disturb servo PWM.
  // Re-asserting servo positions immediately overrides any EMI-induced displacement.
  if (channel == 1) {
    servoLeft.write(currentLeftPosition);
    servoRight.write(currentRightPosition);
  }
}

void allRelaysOff() {
  for (int i = 1; i <= 8; i++) {
    setRelay(i, false);
  }
}
