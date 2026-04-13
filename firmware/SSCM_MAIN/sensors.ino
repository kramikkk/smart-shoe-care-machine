/**
 * Sensor Readings
 * Handles DHT11 temperature/humidity and Ultrasonic level sensing.
 */

/* ===================== DHT11 SENSOR ===================== */

bool readDHT11() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    LOG("[SENSOR:DHT] Failed to read from DHT sensor!");
    return false;
  }

  currentTemperature = t;
  currentHumidity = h;
  LOG("[SENSOR:DHT] Temp=" + String(t, 1) + "C | Humidity=" + String(h, 1) + "%");
  return true;
}

void sendDHTDataViaWebSocket() {
  if (!wsConnected || !isPaired) return;

  String payload = "{";
  payload += "\"type\":\"sensor-data\",";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"temperature\":" + String(currentTemperature, 1) + ",";
  payload += "\"humidity\":" + String(currentHumidity, 1);
  payload += "}";

  webSocket.sendTXT(payload);
}

/* ===================== ULTRASONIC SENSORS ===================== */

// Returns raw echo duration in µs. Returns 0 on timeout (matches old working behaviour).
// 3 samples, 25ms timeout, 5ms inter-sample gap — identical to last working monolith.
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
  // Sort 3 values and return median
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  if (samples[1] > samples[2]) { unsigned long t = samples[1]; samples[1] = samples[2]; samples[2] = t; }
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  return samples[1];
}

bool readAtomizerLevel() {
  unsigned long duration = ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);
  if (duration == 0) {
    currentAtomizerDistance = -1;
    currentAtomizerLevel = 0;
    LOG("[SENSOR:US] ATOMIZER -> INVALID (timeout/no echo)");
    return false;
  }
  int distance = (int)(duration * 0.0174f); // 348 m/s one-way = 0.0174 cm/µs
  if (distance > 21) {
    currentAtomizerDistance = -1;
    currentAtomizerLevel = 0;
    LOG("[SENSOR:US] ATOMIZER -> OUT OF RANGE (" + String(distance) + "cm)");
    return false;
  }
  currentAtomizerDistance = distance;
  currentAtomizerLevel = map(constrain(distance, 2, 20), 20, 2, 0, 100);
  float liters = max(0.0f, (21.0f - distance) / 21.0f * 8.0f);
  LOG("[SENSOR:US] ATOMIZER -> " + String(distance) + "cm | " + String(liters, 1) + "L");
  return true;
}

bool readFoamLevel() {
  delay(20); // Prevent cross-sensor echo bleed from atomizer read
  unsigned long duration = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);
  if (duration == 0) {
    currentFoamDistance = -1;
    currentFoamLevel = 0;
    LOG("[SENSOR:US] FOAM    -> INVALID (timeout/no echo)");
    return false;
  }
  int distance = (int)(duration * 0.0174f);
  if (distance > 21) {
    currentFoamDistance = -1;
    currentFoamLevel = 0;
    LOG("[SENSOR:US] FOAM    -> OUT OF RANGE (" + String(distance) + "cm)");
    return false;
  }
  currentFoamDistance = distance;
  currentFoamLevel = map(constrain(distance, 2, 20), 20, 2, 0, 100);
  float liters = max(0.0f, (21.0f - distance) / 21.0f * 8.0f);
  LOG("[SENSOR:US] FOAM    -> " + String(distance) + "cm | " + String(liters, 1) + "L");
  return true;
}

void sendUltrasonicDataViaWebSocket() {
  if (!wsConnected || !isPaired) return;

  String payload = "{";
  payload += "\"type\":\"distance-data\",";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"atomizerLevel\":" + String(currentAtomizerLevel) + ",";
  payload += "\"foamLevel\":" + String(currentFoamLevel) + ",";
  payload += "\"atomizerDistance\":" + String(currentAtomizerDistance) + ",";
  payload += "\"foamDistance\":" + String(currentFoamDistance);
  payload += "}";

  webSocket.sendTXT(payload);
}
