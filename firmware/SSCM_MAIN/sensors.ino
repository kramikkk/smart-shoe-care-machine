/* ===================== DHT SENSOR ===================== */

bool readDHT11() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  if (isnan(temp) || isnan(hum)) return false;
  currentTemperature = temp;
  currentHumidity    = hum;
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

// Take 3 pulseIn samples and return the median duration (µs).
// 3 samples gives enough outlier rejection while keeping worst-case
// blocking at ~85ms per sensor (vs 240ms with 5 samples).
static unsigned long ultrasonicMedian(uint8_t trigPin, uint8_t echoPin) {
  unsigned long samples[3];
  for (int i = 0; i < 3; i++) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(20);
    digitalWrite(trigPin, LOW);
    samples[i] = pulseIn(echoPin, HIGH, 25000); // 25ms timeout
    if (i < 2) delay(5); // prevent echo bleed between samples
  }
  // Sort and return median
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  if (samples[1] > samples[2]) { unsigned long t = samples[1]; samples[1] = samples[2]; samples[2] = t; }
  if (samples[0] > samples[1]) { unsigned long t = samples[0]; samples[0] = samples[1]; samples[1] = t; }
  return samples[1];
}

bool readAtomizerLevel() {
  unsigned long duration = ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);
  if (duration == 0) { currentAtomizerDistance = -1; return true; }
  int distance = (int)(duration * 0.0174f); // 348m/s one-way = 0.0174 cm/µs
  currentAtomizerDistance = (distance > 21) ? -1 : distance;
  return true;
}

bool readFoamLevel() {
  delay(20); // Gap prevents cross-sensor echo interference
  unsigned long duration = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);
  if (duration == 0) { currentFoamDistance = -1; return true; }
  int distance = (int)(duration * 0.0174f);
  currentFoamDistance = (distance > 21) ? -1 : distance;
  return true;
}

void sendUltrasonicDataViaWebSocket() {
  if (!isPaired || !wsConnected) return;

  webSocket.sendTXT("{\"type\":\"distance-data\",\"deviceId\":\"" + deviceId +
                    "\",\"atomizerDistance\":" + String(currentAtomizerDistance) +
                    ",\"foamDistance\":" + String(currentFoamDistance) + "}");
}
