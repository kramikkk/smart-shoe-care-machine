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

void sendDHTDataViaWebSocket(bool invalid) {
  if (!wsConnected || !isPaired) return;

  String payload = "{";
  payload += "\"type\":\"sensor-data\",";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  if (invalid) {
    payload += "\"temperature\":-1,";
    payload += "\"humidity\":-1";
  } else {
    payload += "\"temperature\":" + String(currentTemperature, 1) + ",";
    payload += "\"humidity\":" + String(currentHumidity, 1);
  }
  // Align with status-update / cam-sync-status so dashboards and throttled DB sync see CAM state on each telemetry tick.
  payload += ",\"camSynced\":" + String(camIsReady ? "true" : "false");
  if (pairedCamDeviceId.length() > 0) {
    payload += ",\"camDeviceId\":\"" + pairedCamDeviceId + "\"";
  }
  payload += "}";

  webSocket.sendTXT(payload);
}

/* ===================== ULTRASONIC SENSORS ===================== */

/**
 * Trigger one ultrasonic pulse and return the echo duration in microseconds.
 * Returns 0 on timeout (no object detected within range).
 *
 * Trigger sequence: pull TRIG LOW 2µs → HIGH 20µs → LOW to fire the burst.
 * 20µs high time generates the 8-cycle 40 kHz burst required by HC-SR04 / similar sensors.
 * pulseIn timeout = 25000µs ≈ 430cm max range; anything beyond that returns 0.
 *
 * Takes 3 samples and returns the median to reject single outliers caused by
 * surface reflections or stepper motor vibration. A 5ms gap between samples
 * ensures the previous echo has fully dissipated before the next trigger.
 */
static unsigned long ultrasonicMedian(uint8_t trigPin, uint8_t echoPin) {
  unsigned long samples[3];
  for (int i = 0; i < 3; i++) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);   // Ensure TRIG is LOW before pulse
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(20);  // Fire the ultrasonic burst (8-cycle 40kHz)
    digitalWrite(trigPin, LOW);
    samples[i] = pulseIn(echoPin, HIGH, 25000); // 25ms timeout ≈ 430cm
    if (i < 2) delay(5); // 5ms inter-sample gap: let echo decay before next pulse
  }
  // Insertion-sort 3 values and return the middle (median) to filter outliers.
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  if (samples[1] > samples[2]) { unsigned long t = samples[1]; samples[1] = samples[2]; samples[2] = t; }
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  return samples[1];
}

/**
 * Read and calculate atomizer liquid level.
 *
 * Distance formula: distance_cm = echo_µs × (speed_of_sound / 2)
 *   Speed of sound ≈ 348 m/s at ~25°C → one-way = 0.0174 cm/µs
 *
 * Tank geometry: sensor is mounted at the top looking down.
 *   21cm reading = empty tank (0L), 0cm reading = full tank (8L).
 *   Map is inverted: closer distance = higher fill level.
 *
 * currentAtomizerLevel is 0–100% (for the dashboard percentage bar).
 * Liters are logged for human readability but not sent separately.
 */
bool readAtomizerLevel() {
  unsigned long duration = ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);
  if (duration == 0) {
    currentAtomizerDistance = -1;
    currentAtomizerLevel    = 0;
    LOG("[SENSOR:US] ATOMIZER -> INVALID (timeout/no echo)");
    return false;
  }
  int distance = (int)(duration * 0.0174f); // echo µs × 0.0174 cm/µs = one-way distance in cm
  if (distance > 21) {
    // Beyond tank depth — sensor may be misaligned or liquid is absent
    currentAtomizerDistance = -1;
    currentAtomizerLevel    = 0;
    LOG("[SENSOR:US] ATOMIZER -> OUT OF RANGE (" + String(distance) + "cm)");
    return false;
  }
  currentAtomizerDistance = distance;
  // Invert the mapping: 20cm→0%, 2cm→100% (constrain prevents negative/over values).
  currentAtomizerLevel = map(constrain(distance, 2, 20), 20, 2, 0, 100);
  // Liter conversion: (21 - distance) / 21 × 8L — linear fill from empty (21cm) to full (0cm = 8L)
  float liters = max(0.0f, (21.0f - distance) / 21.0f * 8.0f);
  LOG("[SENSOR:US] ATOMIZER -> " + String(distance) + "cm | " + String(liters, 1) + "L");
  return true;
}

/**
 * Read and calculate foam liquid level — same geometry and formula as atomizer.
 * 20ms delay before reading prevents the atomizer's outgoing echo from bleeding
 * into the foam sensor's ECHO pin (cross-talk on adjacent sensor pairs).
 */
bool readFoamLevel() {
  delay(20); // Wait for atomizer echo to fully dissipate before triggering foam sensor
  unsigned long duration = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);
  if (duration == 0) {
    currentFoamDistance = -1;
    currentFoamLevel    = 0;
    LOG("[SENSOR:US] FOAM    -> INVALID (timeout/no echo)");
    return false;
  }
  int distance = (int)(duration * 0.0174f);
  if (distance > 21) {
    currentFoamDistance = -1;
    currentFoamLevel    = 0;
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
