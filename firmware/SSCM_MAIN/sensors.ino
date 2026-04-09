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

long ultrasonicMedian(int trigPin, int echoPin, int samples = 5) {
  long readings[samples];
  for (int i = 0; i < samples; i++) {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);
    long duration = pulseIn(echoPin, HIGH, 30000);
    readings[i] = (duration == 0) ? -1 : (duration * 0.034 / 2);
    delay(10);
  }

  for (int i = 0; i < samples - 1; i++) {
    for (int j = i + 1; j < samples; j++) {
      if (readings[i] > readings[j]) {
        long temp = readings[i];
        readings[i] = readings[j];
        readings[j] = temp;
      }
    }
  }
  return readings[samples / 2];
}

bool readAtomizerLevel() {
  long distance = ultrasonicMedian(ATOMIZER_TRIG_PIN, ATOMIZER_ECHO_PIN);
  if (distance == -1) return false;
  currentAtomizerDistance = distance;
  currentAtomizerLevel = map(constrain(distance, 2, 20), 20, 2, 0, 100);
  return true;
}

bool readFoamLevel() {
  long distance = ultrasonicMedian(FOAM_TRIG_PIN, FOAM_ECHO_PIN);
  if (distance == -1) return false;
  currentFoamDistance = distance;
  currentFoamLevel = map(constrain(distance, 2, 20), 20, 2, 0, 100);
  return true;
}

void sendUltrasonicDataViaWebSocket() {
  if (!wsConnected || !isPaired) return;

  String payload = "{";
  payload += "\"type\":\"level-data\",";
  payload += "\"deviceId\":\"" + deviceId + "\",";
  payload += "\"atomizerLevel\":" + String(currentAtomizerLevel) + ",";
  payload += "\"foamLevel\":" + String(currentFoamLevel) + ",";
  payload += "\"atomizerDist\":" + String(currentAtomizerDistance) + ",";
  payload += "\"foamDist\":" + String(currentFoamDistance);
  payload += "}";

  webSocket.sendTXT(payload);
}
