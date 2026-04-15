/**
 * Relay Management
 * Controls the 8-channel active-HIGH relay module.
 *
 * Channel assignments (RELAY_ON = HIGH, RELAY_OFF = LOW):
 *   1 — Coin/bill acceptor power rail  (enabled by enable-payment WS command)
 *   2 — Bottom exhaust fan             (purge after drying / sterilizing; drying temp overflow)
 *   3 — Drying fan                     (forced hot-air circulation during drying)
 *   4 — Left PTC heater                (heating element; cycled by temperature control loop)
 *   5 — Diaphragm pump                 (spray nozzle during cleaning approach & oscillation)
 *   6 — Right PTC heater               (heating element; cycled by temperature control loop)
 *   7 — Mist maker (ultrasonic)        (atomises sterilising solution during sterilizing)
 *   8 — UVC light                      (UV-C germicidal lamp during sterilizing)
 */

/**
 * Set a single relay channel to the given state and report the new state to the backend.
 * channel: 1–8 (values outside this range are silently ignored via the pin == -1 guard)
 * state: true = ON (RELAY_ON / HIGH), false = OFF (RELAY_OFF / LOW)
 * A relay-status WS message is emitted so the dashboard can reflect the live state.
 */
void setRelay(int channel, bool state) {
  int pin = -1;
  switch (channel) {
  case 1: pin = RELAY_1_PIN; relay1State = state; break; // Coin/bill acceptor power rail
  case 2: pin = RELAY_2_PIN; relay2State = state; break; // Bottom exhaust fan
  case 3: pin = RELAY_3_PIN; relay3State = state; break; // Drying fan
  case 4: pin = RELAY_4_PIN; relay4State = state; break; // Left PTC heater
  case 5: pin = RELAY_5_PIN; relay5State = state; break; // Diaphragm pump
  case 6: pin = RELAY_6_PIN; relay6State = state; break; // Right PTC heater
  case 7: pin = RELAY_7_PIN; relay7State = state; break; // Mist maker
  case 8: pin = RELAY_8_PIN; relay8State = state; break; // UVC light
  }

  if (pin != -1) {
    digitalWrite(pin, state ? RELAY_ON : RELAY_OFF);

    // Notify the dashboard so it can update its live relay-state display.
    if (wsConnected) {
      String msg = "{\"type\":\"relay-status\",\"deviceId\":\"" + deviceId +
                   "\",\"channel\":" + String(channel) + ",\"state\":" +
                   (state ? "true" : "false") + "}";
      webSocket.sendTXT(msg);
    }
  }
}

/**
 * Cut power to all relay channels simultaneously.
 * Called as a safety measure before: OTA firmware updates, factory reset,
 * and at the start of every service to guarantee a clean actuator state.
 * Sends an all-relays-off WS event so the dashboard indicators reset in one shot.
 */
void allRelaysOff() {
  digitalWrite(RELAY_1_PIN, RELAY_OFF);
  digitalWrite(RELAY_2_PIN, RELAY_OFF);
  digitalWrite(RELAY_3_PIN, RELAY_OFF);
  digitalWrite(RELAY_4_PIN, RELAY_OFF);
  digitalWrite(RELAY_5_PIN, RELAY_OFF);
  digitalWrite(RELAY_6_PIN, RELAY_OFF);
  digitalWrite(RELAY_7_PIN, RELAY_OFF);
  digitalWrite(RELAY_8_PIN, RELAY_OFF);

  // Mirror GPIO state in tracking variables so service logic stays consistent.
  relay1State = false; relay2State = false; relay3State = false; relay4State = false;
  relay5State = false; relay6State = false; relay7State = false; relay8State = false;

  if (wsConnected) {
    String msg = "{\"type\":\"all-relays-off\",\"deviceId\":\"" + deviceId + "\"}";
    webSocket.sendTXT(msg);
  }
}
