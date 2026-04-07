/**
 * ===================== SENSOR MODULES =====================
 *
 * DHT11 — Temperature & humidity sensor
 *   Read every 5s. Used for drying temperature control (35–40°C hysteresis)
 *   and humidity display on dashboard. Sends data via WebSocket.
 *
 * JSN-SR20-Y1 × 2 — Ultrasonic distance sensors
 *   Measure liquid levels in atomizer and foam tanks (0–21cm range).
 *   Uses median-of-3 sampling for noise rejection. pulseIn() blocks ~30ms
 *   per sensor, so readings are skipped during stepper movement.
 */

bool readDHT11() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  if (isnan(temp) || isnan(hum)) {
    LOG("[DHT] Read failed");
    return false;
  }
  currentTemperature = temp;
  currentHumidity    = hum;
  LOG("[DHT] " + String(temp, 1) + "C " + String(hum, 1) + "%");
  return true;
}

void sendDHTDataViaWebSocket() {
  if (!isPaired || !wsConnected) return;

  String msg = "{\"type\":\"sensor-data\",\"deviceId\":\"" + deviceId +
               "\",\"temperature\":" + String(currentTemperature, 1) +
               ",\"humidity\":" + String(currentHumidity, 1) +
               ",\"camSynced\":" + String(camIsReady ? "true" : "false");
  if (pairedCamDeviceId.length() > 0) {
    msg += ",\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  }
  msg += "}";
  webSocket.sendTXT(msg);
}

/* ===================== ULTRASONIC SENSORS ===================== */

static unsigned long ultrasonicMedian(uint8_t trigPin, uint8_t echoPin) {
  unsigned long samples[3];
  for (int i = 0; i < 3; i++) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(20);
    digitalWrite(trigPin, LOW);
    samples[i] = pulseIn(echoPin, HIGH, 25000);
    if (i < 2) delay(5);
  }
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  if (samples[1] > samples[2]) { unsigned long t = samples[1]; samples[1] = samples[2]; samples[2] = t; }
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  return samples[1];
}

bool readAtomizerLevel() {
  unsigned long duration = ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);
  if (duration == 0) { currentAtomizerDistance = -1; return true; }
  int distance = (int)(duration * 0.0174f);
  currentAtomizerDistance = (distance > 21) ? -1 : distance;
  LOG("[Ultrasonic] Atomizer: " + String(currentAtomizerDistance) + "cm");
  return true;
}

bool readFoamLevel() {
  delay(20);
  unsigned long duration = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);
  if (duration == 0) { currentFoamDistance = -1; return true; }
  int distance = (int)(duration * 0.0174f);
  currentFoamDistance = (distance > 21) ? -1 : distance;
  LOG("[Ultrasonic] Foam: " + String(currentFoamDistance) + "cm");
  return true;
}

void sendUltrasonicDataViaWebSocket() {
  if (!isPaired || !wsConnected) return;

  webSocket.sendTXT("{\"type\":\"distance-data\",\"deviceId\":\"" + deviceId +
                    "\",\"atomizerDistance\":" + String(currentAtomizerDistance) +
                    ",\"foamDistance\":" + String(currentFoamDistance) + "}");
}
