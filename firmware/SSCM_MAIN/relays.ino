/**
 * Relay Management
 * Controls the 8-channel relay module.
 */

void setRelay(int channel, bool state) {
  int pin = -1;
  switch (channel) {
  case 1: pin = RELAY_1_PIN; relay1State = state; break;
  case 2: pin = RELAY_2_PIN; relay2State = state; break;
  case 3: pin = RELAY_3_PIN; relay3State = state; break;
  case 4: pin = RELAY_4_PIN; relay4State = state; break;
  case 5: pin = RELAY_5_PIN; relay5State = state; break;
  case 6: pin = RELAY_6_PIN; relay6State = state; break;
  case 7: pin = RELAY_7_PIN; relay7State = state; break;
  case 8: pin = RELAY_8_PIN; relay8State = state; break;
  }

  if (pin != -1) {
    digitalWrite(pin, state ? RELAY_ON : RELAY_OFF);
    
    if (wsConnected) {
      String msg = "{\"type\":\"relay-status\",\"deviceId\":\"" + deviceId +
                   "\",\"channel\":" + String(channel) + ",\"state\":" +
                   (state ? "true" : "false") + "}";
      webSocket.sendTXT(msg);
    }
  }
}

void allRelaysOff() {
  digitalWrite(RELAY_1_PIN, RELAY_OFF);
  digitalWrite(RELAY_2_PIN, RELAY_OFF);
  digitalWrite(RELAY_3_PIN, RELAY_OFF);
  digitalWrite(RELAY_4_PIN, RELAY_OFF);
  digitalWrite(RELAY_5_PIN, RELAY_OFF);
  digitalWrite(RELAY_6_PIN, RELAY_OFF);
  digitalWrite(RELAY_7_PIN, RELAY_OFF);
  digitalWrite(RELAY_8_PIN, RELAY_OFF);

  relay1State = false; relay2State = false; relay3State = false; relay4State = false;
  relay5State = false; relay6State = false; relay7State = false; relay8State = false;

  if (wsConnected) {
    String msg = "{\"type\":\"all-relays-off\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(msg);
  }
}
