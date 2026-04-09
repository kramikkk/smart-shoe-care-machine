/**
 * ESP-NOW Communication
 * Handles peer-to-peer data exchange with the ESP32-CAM module.
 */

// Enqueue a deferred ESP-NOW action (call from onDataRecv only)
static void espNowEnqueue(EspNowPending action, const char *shoeType = "",
                          float confidence = 0.0f, const char *errorCode = "") {
  bool dropped = false;
  portENTER_CRITICAL(&espNowMux);
  uint8_t next = (espNowQueueTail + 1) % ESPNOW_QUEUE_SIZE;
  if (next != espNowQueueHead) {
    espNowQueue[espNowQueueTail].action = action;
    strncpy(espNowQueue[espNowQueueTail].shoeType, shoeType, 31);
    espNowQueue[espNowQueueTail].shoeType[31] = '\0';
    espNowQueue[espNowQueueTail].confidence = confidence;
    strncpy(espNowQueue[espNowQueueTail].errorCode, errorCode, 31);
    espNowQueue[espNowQueueTail].errorCode[31] = '\0';
    espNowQueueTail = next;
  } else {
    dropped = true;
  }
  portEXIT_CRITICAL(&espNowMux);

  if (dropped) {
    // Queue full - message dropped
  }
}

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
     // Optional: Handle send failure
  }
}

void onDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
  if (len < 1) return;

  uint8_t msgType = data[0];
  uint8_t *senderMac = recv_info->src_addr;

  if (msgType == CAM_MSG_PAIR_ACK) {
    if (len < (int)sizeof(PairingAck)) return;
    PairingAck ack;
    memcpy(&ack, data, sizeof(PairingAck));
    pairedCamDeviceId = String(ack.camOwnDeviceId);
    prefs.putString("camDeviceId", pairedCamDeviceId);
    if (strlen(ack.camIp) > 0) {
      pairedCamIp = String(ack.camIp);
      prefs.putString("camIp", pairedCamIp);
    }
    if (!camMacPaired) {
      memcpy(camMacAddress, senderMac, 6);
      prefs.putBytes("camMac", camMacAddress, 6);
      camMacPaired = true;
      esp_now_del_peer(broadcastAddress);
      esp_now_peer_info_t peer;
      memset(&peer, 0, sizeof(peer));
      memcpy(peer.peer_addr, camMacAddress, 6);
      peer.channel = 0;
      peer.encrypt = false;
      esp_now_add_peer(&peer);
    }
    camIsReady = true;
    lastCamHeartbeat = millis();
    espNowEnqueue(ESPNOW_CAM_PAIRED);
    return;
  }

  if (msgType == CAM_MSG_CLASSIFY_RESULT) {
    if (len < (int)sizeof(CamMessage)) return;
    CamMessage msg;
    memcpy(&msg, data, sizeof(CamMessage));
    lastCamHeartbeat = millis();
    classificationPending = false;
    switch (msg.status) {
    case CAM_STATUS_OK: espNowEnqueue(ESPNOW_CLASSIFY_OK, msg.shoeType, msg.confidence); break;
    case CAM_STATUS_LOW_CONFIDENCE: espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "LOW_CONFIDENCE"); break;
    case CAM_STATUS_BUSY: espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAM_BUSY"); break;
    case CAM_STATUS_TIMEOUT: espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_TIMEOUT"); break;
    case CAM_STATUS_NOT_READY: espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAMERA_NOT_READY"); break;
    case CAM_STATUS_API_HANDLED: classificationPending = false; espNowEnqueue(ESPNOW_API_HANDLED); break;
    case CAM_STATUS_ERROR: default: espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_ERROR"); break;
    }
    return;
  }

  if (msgType == CAM_MSG_STATUS_PONG) {
    if (len < (int)sizeof(CamMessage)) return;
    lastCamHeartbeat = millis();
    return;
  }
}

void initESPNow() {
  if (espNowInitialized) return;
  if (esp_now_init() != ESP_OK) return;

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  size_t macLen = prefs.getBytes("camMac", camMacAddress, 6);
  if (macLen == 6 && (camMacAddress[0] != 0x00 || camMacAddress[1] != 0x00)) camMacPaired = true;
  pairedCamDeviceId = prefs.getString("camDeviceId", "");
  pairedCamIp = prefs.getString("camIp", "");

  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  if (camMacPaired) memcpy(peer.peer_addr, camMacAddress, 6);
  else memcpy(peer.peer_addr, broadcastAddress, 6);
  peer.channel = 0;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) return;
  espNowInitialized = true;
}

void sendPairingBroadcast() {
  if (!espNowInitialized) return;
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  if (ssid.length() == 0) return;

  PairingBroadcast pb;
  memset(&pb, 0, sizeof(pb));
  pb.type = CAM_MSG_PAIR_REQUEST;
  strncpy(pb.groupToken, groupToken.c_str(), sizeof(pb.groupToken) - 1);
  strncpy(pb.deviceId, deviceId.c_str(), sizeof(pb.deviceId) - 1);
  strncpy(pb.ssid, ssid.c_str(), sizeof(pb.ssid) - 1);
  strncpy(pb.password, pass.c_str(), sizeof(pb.password) - 1);
  strncpy(pb.wsHost, BACKEND_HOST, sizeof(pb.wsHost) - 1);
  pb.wsPort = BACKEND_PORT;

  uint8_t *targetMac = camMacPaired ? camMacAddress : broadcastAddress;
  esp_now_send(targetMac, (uint8_t *)&pb, sizeof(pb));
  pairingBroadcastStarted = true;
  lastPairingBroadcastTime = millis();
}

void sendClassifyRequest() {
  if (!espNowInitialized || !camMacPaired) return;
  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = CAM_MSG_CLASSIFY_REQUEST;
  msg.status = CAM_STATUS_OK;
  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
  classificationPending = true;
  classificationRequestTime = millis();
  wsLog("info", "Classification request sent to CAM via ESP-NOW");
}

void sendLedControl(uint8_t ledMsgType) {
  if (!espNowInitialized || !camMacPaired) return;
  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = ledMsgType;
  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
}
