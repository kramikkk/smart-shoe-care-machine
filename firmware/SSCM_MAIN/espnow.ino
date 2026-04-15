/**
 * ESP-NOW Communication
 * Handles peer-to-peer data exchange with the ESP32-CAM module.
 */

/**
 * Enqueue a deferred ESP-NOW action for processing in loop().
 * Must only be called from onDataRecv (radio interrupt context) — never from loop().
 * Uses a circular buffer protected by espNowMux; drops the entry when the queue is full
 * rather than blocking the radio callback.
 */
static void espNowEnqueue(EspNowPending action, const char *shoeType = "",
                          float confidence = 0.0f, const char *errorCode = "") {
  bool dropped = false;
  portENTER_CRITICAL(&espNowMux);
  uint8_t next = (espNowQueueTail + 1) % ESPNOW_QUEUE_SIZE;
  if (next != espNowQueueHead) {
    // Write to tail slot and advance the tail pointer
    espNowQueue[espNowQueueTail].action = action;
    strncpy(espNowQueue[espNowQueueTail].shoeType, shoeType, 31);
    espNowQueue[espNowQueueTail].shoeType[31] = '\0';
    espNowQueue[espNowQueueTail].confidence = confidence;
    strncpy(espNowQueue[espNowQueueTail].errorCode, errorCode, 31);
    espNowQueue[espNowQueueTail].errorCode[31] = '\0';
    espNowQueueTail = next;
  } else {
    dropped = true; // Queue full — this action will be lost
  }
  portEXIT_CRITICAL(&espNowMux);

  if (dropped) {
    // Cannot call LOG here (not ISR-safe); the drop is silent.
    // If this happens in practice, increase ESPNOW_QUEUE_SIZE.
  }
}

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
     // Optional: Handle send failure
  }
}

/**
 * ESP-NOW receive callback — runs in radio interrupt context.
 * Only enqueues work; no heavy operations (WebSocket, HTTP, NVS writes) happen here.
 */
void onDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
  if (len < 1) return;

  uint8_t msgType  = data[0];
  uint8_t *senderMac = recv_info->src_addr;

  if (msgType == CAM_MSG_PAIR_ACK) {
    if (len < (int)sizeof(PairingAck)) return;
    PairingAck ack;
    memcpy(&ack, data, sizeof(PairingAck));

    // Persist CAM identity so it survives a MAIN reboot.
    pairedCamDeviceId = String(ack.camOwnDeviceId);
    prefs.putString("camDeviceId", pairedCamDeviceId);
    if (strlen(ack.camIp) > 0) {
      pairedCamIp = String(ack.camIp);
      prefs.putString("camIp", pairedCamIp); // Stored for diagnostics; not used in service flow
    }

    if (!camMacPaired) {
      // First-time pairing: record the CAM's MAC and switch from broadcast to unicast.
      // Removing the broadcast peer prevents future sendPairingBroadcast() calls from
      // being sent to the broadcast address now that we have a specific peer.
      memcpy(camMacAddress, senderMac, 6);
      prefs.putBytes("camMac", camMacAddress, 6);
      camMacPaired = true;
      esp_now_del_peer(broadcastAddress); // No longer needed once paired
      esp_now_peer_info_t peer;
      memset(&peer, 0, sizeof(peer));
      memcpy(peer.peer_addr, camMacAddress, 6);
      peer.channel = 0;
      peer.encrypt = false;
      esp_now_add_peer(&peer); // Register the specific CAM MAC for unicast sends
    }

    camIsReady = true;
    lastCamHeartbeat = millis(); // Reset heartbeat timeout on successful pairing
    espNowEnqueue(ESPNOW_CAM_PAIRED); // Notify backend via loop()
    return;
  }

  if (msgType == CAM_MSG_CLASSIFY_RESULT) {
    if (len < (int)sizeof(CamMessage)) return;
    CamMessage msg;
    memcpy(&msg, data, sizeof(CamMessage));

    lastCamHeartbeat = millis(); // Any CLASSIFY_RESULT counts as a liveness signal
    classificationPending = false; // Clear the timeout watchdog regardless of outcome

    // Map each CAM status to a queue entry for loop() to relay to the backend.
    switch (msg.status) {
    case CAM_STATUS_OK:
      // Valid result — shoeType and confidence (0.0–1.0) are populated.
      espNowEnqueue(ESPNOW_CLASSIFY_OK, msg.shoeType, msg.confidence);
      break;
    case CAM_STATUS_LOW_CONFIDENCE:
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "LOW_CONFIDENCE");
      break;
    case CAM_STATUS_BUSY:
      // CAM was already mid-classification when the request arrived.
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAM_BUSY");
      break;
    case CAM_STATUS_TIMEOUT:
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_TIMEOUT");
      break;
    case CAM_STATUS_NOT_READY:
      // Camera driver failed to initialise at boot.
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CAMERA_NOT_READY");
      break;
    case CAM_STATUS_API_HANDLED:
      // Gemini path: CAM posted the JPEG to the backend; result will arrive via WebSocket.
      // classificationPending already cleared above; just log it in loop().
      espNowEnqueue(ESPNOW_API_HANDLED);
      break;
    case CAM_STATUS_ERROR:
    default:
      espNowEnqueue(ESPNOW_CLASSIFY_ERROR, "", 0.0f, "CLASSIFICATION_ERROR");
      break;
    }
    return;
  }

  if (msgType == CAM_MSG_STATUS_PONG) {
    // Reply to our periodic ping — update heartbeat timestamp to prevent offline marking.
    if (len < (int)sizeof(CamMessage)) return;
    lastCamHeartbeat = millis();
    return;
  }
}

/**
 * Initialise ESP-NOW and register the initial peer.
 * - If a CAM MAC is stored in NVS (from a previous pairing), register it as a unicast peer.
 * - Otherwise, register the broadcast address so sendPairingBroadcast() can reach any CAM.
 * MAC validity check: both bytes 0 and 1 being 0x00 indicates an uninitialised NVS slot
 * (all-zero is not a valid real MAC for any Espressif module).
 */
void initESPNow() {
  if (espNowInitialized) return;
  if (esp_now_init() != ESP_OK) return;

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  // Restore previously paired CAM state from NVS.
  size_t macLen = prefs.getBytes("camMac", camMacAddress, 6);
  if (macLen == 6 && (camMacAddress[0] != 0x00 || camMacAddress[1] != 0x00)) {
    camMacPaired = true; // Valid stored MAC — use unicast from here on
  }
  pairedCamDeviceId = prefs.getString("camDeviceId", "");
  pairedCamIp       = prefs.getString("camIp", "");

  // Register either the known CAM MAC (unicast) or broadcast as the initial send target.
  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  if (camMacPaired) memcpy(peer.peer_addr, camMacAddress,   6);
  else              memcpy(peer.peer_addr, broadcastAddress, 6);
  peer.channel = 0;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) return;
  espNowInitialized = true;
}

/**
 * Broadcast WiFi credentials and backend info to any listening CAM board.
 * - If already paired (camMacPaired), sends unicast to the known CAM MAC — avoids
 *   re-provisioning a different CAM that might be nearby.
 * - If not yet paired, sends to FF:FF:FF:FF:FF:FF so any unpaired CAM can receive it.
 * Silently skipped if WiFi is not yet configured (no SSID in NVS).
 */
void sendPairingBroadcast() {
  if (!espNowInitialized) return;
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  if (ssid.length() == 0) return; // Cannot provision a CAM without WiFi credentials

  PairingBroadcast pb;
  memset(&pb, 0, sizeof(pb));
  pb.type = CAM_MSG_PAIR_REQUEST;
  strncpy(pb.groupToken, groupToken.c_str(), sizeof(pb.groupToken) - 1);
  strncpy(pb.deviceId,   deviceId.c_str(),   sizeof(pb.deviceId) - 1);
  strncpy(pb.ssid,       ssid.c_str(),        sizeof(pb.ssid) - 1);
  strncpy(pb.password,   pass.c_str(),         sizeof(pb.password) - 1);
  strncpy(pb.wsHost,     BACKEND_HOST,         sizeof(pb.wsHost) - 1);
  pb.wsPort = BACKEND_PORT;

  uint8_t *targetMac = camMacPaired ? camMacAddress : broadcastAddress;
  esp_now_send(targetMac, (uint8_t *)&pb, sizeof(pb));
  pairingBroadcastStarted  = true;
  lastPairingBroadcastTime = millis();
}

/**
 * Send a classification trigger to the paired CAM board via ESP-NOW.
 * Sets classificationPending = true so the timeout watchdog in loop() can detect
 * a non-responding CAM and relay an error to the backend after CAM_CLASSIFY_TIMEOUT_MS.
 */
void sendClassifyRequest() {
  if (!espNowInitialized || !camMacPaired) return;
  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type   = CAM_MSG_CLASSIFY_REQUEST;
  msg.status = CAM_STATUS_OK;
  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
  classificationPending     = true;
  classificationRequestTime = millis(); // Start the timeout countdown
  wsLog("info", "Classification request sent to CAM via ESP-NOW");
}

void sendLedControl(uint8_t ledMsgType) {
  if (!espNowInitialized || !camMacPaired) return;
  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = ledMsgType;
  esp_now_send(camMacAddress, (uint8_t *)&msg, sizeof(msg));
}
