/**
 * Add a peer to ESP-NOW if not already added
 */
void addPeerIfNeeded(uint8_t *mac) {
  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0;
    peer.encrypt = false;
    esp_err_t result = esp_now_add_peer(&peer);
    if (result == ESP_OK) {
      LOG("[ESP-NOW] Peer added successfully");
    } else {
      LOG("[ESP-NOW] Failed to add peer: " + String(result));
    }
  }
}

/**
 * Send CamMessage to paired main board
 */
void sendCamMessage(uint8_t type, uint8_t status, const char *shoeType, float confidence) {
  if (!mainBoardPaired) {
    LOG("[CAM:MSG] Not paired, dropping message type=" + String(type));
    return;
  }

  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type = type;
  msg.status = status;
  msg.confidence = confidence;
  if (shoeType) strncpy(msg.shoeType, shoeType, sizeof(msg.shoeType) - 1);

  addPeerIfNeeded(mainBoardMac);
  esp_err_t result = esp_now_send(mainBoardMac, (uint8_t *)&msg, sizeof(msg));
  if (result != ESP_OK) {
    LOG("[CAM:MSG] Send failed: " + String(result));
  }
}

/**
 * Send pairing acknowledgment
 */
void sendPairingAck(uint8_t *targetMac) {
  PairingAck ack;
  memset(&ack, 0, sizeof(ack));
  ack.type = CAM_MSG_PAIR_ACK;
  strncpy(ack.camOwnDeviceId, camOwnDeviceId.c_str(), sizeof(ack.camOwnDeviceId) - 1);
  if (camIp.length() > 0) {
    strncpy(ack.camIp, camIp.c_str(), sizeof(ack.camIp) - 1);
    LOG("[CAM:PAIR:ACK] Sending with IP: " + camIp);
  } else {
    LOG("[CAM:PAIR:ACK] WiFi not connected, sending without IP");
  }

  addPeerIfNeeded(targetMac);
  esp_err_t res = esp_now_send(targetMac, (uint8_t *)&ack, sizeof(ack));
  if (res != ESP_OK) {
    LOG("[CAM:PAIR:ACK] Send failed: " + String(res));
  }
}

/**
 * ESP-NOW Send Callback
 */
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    LOG("[ESP-NOW] TX FAILED");
  }
}

/**
 * ESP-NOW Receive Callback
 */
void onDataRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
  if (len < 1) return;

  uint8_t msgType = data[0];
  uint8_t *senderMac = recv_info->src_addr;

  if (msgType == CAM_MSG_PAIR_REQUEST) {
    LOG("[CAM:PAIR] Pairing broadcast received");
    if (len < (int)sizeof(PairingBroadcast)) {
       LOG("[CAM:PAIR] Pairing buffer too small, discarding");
       return;
    }

    PairingBroadcast pb;
    memcpy(&pb, data, sizeof(PairingBroadcast));

    if (mainBoardPaired) {
      bool sameBoard = (memcmp(senderMac, mainBoardMac, 6) == 0);
      if (!sameBoard) return;
    }

    pb.groupToken[sizeof(pb.groupToken) - 1] = '\0';
    String token = String(pb.groupToken);
    token.toUpperCase();
    if (token.length() != 8) {
      LOG("[CAM:PAIR] Invalid token length");
      return;
    }

    // HEX VALIDATION (Strict Parity)
    bool tokenValid = true;
    for (int i = 0; i < 8; i++) {
      char c = token[i];
      if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) {
        tokenValid = false;
        break;
      }
    }
    if (!tokenValid) {
      LOG("[CAM:PAIR] Token is not valid hex");
      return;
    }
    LOG("[CAM:PAIR] Valid pairing: token=" + token);

    prefs.putString("ssid", String(pb.ssid));
    prefs.putString("pass", String(pb.password));
    prefs.putString("wsHost", String(pb.wsHost));
    prefs.putUInt("wsPort", pb.wsPort);
    prefs.putString("groupToken", token);
    prefs.putString("mainId", String(pb.deviceId));

    storedGroupToken = token;
    memcpy(mainBoardMac, senderMac, 6);
    prefs.putBytes("mainMac", mainBoardMac, 6);
    mainBoardPaired = true;

    String ssid = String(pb.ssid);
    String pass = String(pb.password);
    if (ssid.length() > 0) {
      LOG("[CAM:PAIR] Connecting to WiFi SSID: " + ssid);
      WiFi.begin(ssid.c_str(), pass.c_str());
      wifiConnectStartMs = millis();
    }

    pairingAckPending = true;
    pairingTime = millis();
    return;
  }

  // Runtime Messages
  if (!mainBoardPaired || memcmp(senderMac, mainBoardMac, 6) != 0) return;
  if (len < (int)sizeof(CamMessage)) return;

  CamMessage msg;
  memcpy(&msg, data, sizeof(CamMessage));

  switch (msg.type) {
    case CAM_MSG_CLASSIFY_REQUEST:
      LOG("[CAM] Classification request from main");
      if (!is_initialised) {
        LOG("[CAM] Camera not ready, sending NOT_READY");
        sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
      } else if (classificationInProgress) {
        LOG("[CAM] Already classifying, sending BUSY");
        sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_BUSY, "", 0.0f);
      } else {
        LOG("[CAM] Classification queued");
        classificationRequested = true;
      }
      break;

    case CAM_MSG_STATUS_PING:
      LOG("[CAM] Status ping from main");
      sendCamMessage(CAM_MSG_STATUS_PONG, is_initialised ? CAM_STATUS_OK : CAM_STATUS_NOT_READY, "", 0.0f);
      break;

    case CAM_MSG_FACTORY_RESET:
      LOG("[CAM] Factory reset requested from main");
      factoryResetRequested = true;
      break;
    
    // Original LED commands (placeholders in monolithic)
    case CAM_MSG_LED_ENABLE: LOG("[CAM] LED_ENABLE"); break;
    case CAM_MSG_LED_DISABLE: LOG("[CAM] LED_DISABLE"); break;
  }
}
