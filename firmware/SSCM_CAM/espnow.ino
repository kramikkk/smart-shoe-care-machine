/**
 * Register a MAC address as an ESP-NOW peer if not already registered.
 * channel=0 means "use the current WiFi channel" (required when both STA and ESP-NOW share the radio).
 * encrypt=false — no CCMP encryption; pairing token provides application-level authenticity.
 */
void addPeerIfNeeded(uint8_t *mac) {
  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = 0;      // 0 = inherit current channel automatically
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
 * Send a CamMessage packet to the paired MAIN board.
 * - For status-only responses (NOT_READY, BUSY, ERROR, API_HANDLED), pass "" and 0.0f.
 * - For CLASSIFY_RESULT with CAM_STATUS_OK, pass the shoeType string and confidence (0.0–1.0).
 */
void sendCamMessage(uint8_t type, uint8_t status, const char *shoeType, float confidence) {
  if (!mainBoardPaired) {
    LOG("[CAM:MSG] Not paired, dropping message type=" + String(type));
    return;
  }

  CamMessage msg;
  memset(&msg, 0, sizeof(msg));
  msg.type       = type;
  msg.status     = status;
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
 * ESP-NOW send callback — fires after the radio has attempted transmission.
 * Keep this function minimal: it runs in the radio interrupt context.
 */
void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    LOG("[ESP-NOW] TX FAILED");
  }
}

/**
 * ESP-NOW receive callback — ALL incoming packets arrive here.
 * This runs in the radio interrupt context, so no heavy work is done here:
 * - Pairing: stores credentials and sets a pending flag; ACK is sent from loop().
 * - Runtime commands: latch a volatile flag; actual work runs in loop().
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

    // If already paired to a MAIN board, only accept re-pairing from the same board.
    // This prevents a rogue MAIN from hijacking a provisioned CAM.
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

    // Strict hex validation — token must be exactly 8 uppercase hex digits [0-9A-F].
    // Rejects tokens with non-hex characters that could pass a weaker length-only check.
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

    // Persist all provisioning data to NVS so CAM survives a reboot without re-pairing.
    prefs.putString("ssid",       String(pb.ssid));
    prefs.putString("pass",       String(pb.password));
    prefs.putString("wsHost",     String(pb.wsHost));
    prefs.putUInt("wsPort",       pb.wsPort);
    prefs.putString("groupToken", token);
    prefs.putString("mainId",     String(pb.deviceId)); // MAIN device ID used in classify endpoint path

    storedGroupToken = token;
    memcpy(mainBoardMac, senderMac, 6);
    prefs.putBytes("mainMac", mainBoardMac, 6);
    mainBoardPaired = true;

    String ssid = String(pb.ssid);
    String pass = String(pb.password);
    // Only call WiFi.begin() when not already connected — re-provision broadcasts
    // from MAIN (sent on every WS connect) update NVS config without disrupting WiFi.
    if (ssid.length() > 0 && !wifiConnected) {
      LOG("[CAM:PAIR] Connecting to WiFi SSID: " + ssid);
      WiFi.begin(ssid.c_str(), pass.c_str());
      wifiConnectStartMs = millis();
    } else if (wifiConnected) {
      LOG("[CAM:PAIR] Already connected, skipping WiFi.begin");
    }

    // Defer the PairingAck to loop() — we need an IP first.
    // The ACK carries our IP so MAIN can reach the CAM's HTTP server.
    pairingAckPending = true;
    pairingTime = millis();
    return;
  }

  // Runtime messages — only accepted from the paired MAIN board (MAC guard).
  // An unpaired CAM or a message from an unknown MAC is silently dropped.
  if (!mainBoardPaired || memcmp(senderMac, mainBoardMac, 6) != 0) return;
  if (len < (int)sizeof(CamMessage)) return;

  CamMessage msg;
  memcpy(&msg, data, sizeof(CamMessage));

  switch (msg.type) {
    case CAM_MSG_CLASSIFY_REQUEST:
      LOG("[CAM] Classification request from main");
      if (!is_initialised) {
        // Camera driver failed at boot — inform MAIN immediately.
        LOG("[CAM] Camera not ready, sending NOT_READY");
        sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_NOT_READY, "", 0.0f);
      } else if (classificationInProgress) {
        // A capture is already running in loop() — refuse without queuing.
        LOG("[CAM] Already classifying, sending BUSY");
        sendCamMessage(CAM_MSG_CLASSIFY_RESULT, CAM_STATUS_BUSY, "", 0.0f);
      } else {
        // Latch the volatile flag; loop() will pick it up and run captureAndPostToBackend().
        LOG("[CAM] Classification queued");
        classificationRequested = true;
      }
      break;

    case CAM_MSG_STATUS_PING:
      // MAIN uses this as a liveness check; reply with camera readiness state.
      LOG("[CAM] Status ping from main");
      sendCamMessage(CAM_MSG_STATUS_PONG, is_initialised ? CAM_STATUS_OK : CAM_STATUS_NOT_READY, "", 0.0f);
      break;

    case CAM_MSG_FACTORY_RESET:
      // Latch flag; actual wipe + restart happens in loop() to avoid NVS writes in ISR context.
      LOG("[CAM] Factory reset requested from main");
      factoryResetRequested = true;
      break;

    case CAM_MSG_LED_ENABLE:  LOG("[CAM] LED_ENABLE");  break; // Illumination LED on (future use)
    case CAM_MSG_LED_DISABLE: LOG("[CAM] LED_DISABLE"); break; // Illumination LED off (future use)
  }
}
