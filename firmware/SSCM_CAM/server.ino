/*
 * HTTP Server for Live Streaming and Snapshots
 */

#define PART_BOUNDARY "frameboundary"

/**
 * Handle Root page
 */
void handleRoot() {
  String page = "<!DOCTYPE html><html><head><title>SSCM CAM</title>";
  page += "<style>body{font-family:sans-serif;background:#121212;color:#eee;text-align:center;padding:20px;}";
  page += "a{color:#007bff;text-decoration:none;} .status{padding:10px;background:#1e1e1e;border-radius:8px;display:inline-block;margin:10px;}</style></head><body>";
  page += "<h2>SSCM CAM — " + camOwnDeviceId + "</h2>";
  page += "<div class='status'><p>IP: " + (wifiConnected ? WiFi.localIP().toString() : "DISCONNECTED") + "</p>";
  page += "<p>Paired: " + (mainBoardPaired ? prefs.getString("mainId", "?") : "NO") + "</p></div>";
  page += "<br><br><a href='/stream'>View Live Stream</a> | <a href='/snapshot'>Capture Snapshot</a>";
  page += "</body></html>";
  httpServer.send(200, "text/html", page);
}

/**
 * MJPEG Stream Handler
 */
void handleStream() {
  WiFiClient client = httpServer.client();
  unsigned long streamStartMs = millis();
  const unsigned long STREAM_TIMEOUT_MS = 60000; // Disconnect stream after 60s

  client.print("HTTP/1.1 200 OK\r\n");
  client.print("Content-Type: multipart/x-mixed-replace; boundary=" PART_BOUNDARY "\r\n");
  client.print("Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n");

  while (client.connected()) {
    yield();
    if (classificationRequested) break; // Pause stream for classification capture
    
    // Prevent stream from blocking WiFi indefinitely
    if ((millis() - streamStartMs) > STREAM_TIMEOUT_MS) {
      LOG("[HTTP] Stream timeout - closing connection");
      break;
    }

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      delay(100);
      continue;
    }

    client.print("\r\n--" PART_BOUNDARY "\r\n");
    client.print("Content-Type: image/jpeg\r\n");
    client.printf("Content-Length: %u\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);

    esp_camera_fb_return(fb);
    delay(50); // ~20 FPS limit
  }
}

/**
 * Single JPEG Snapshot Handler
 */
void handleSnapshot() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    LOG("[HTTP] Snapshot capture failed");
    httpServer.send(500, "text/plain", "Camera capture failed");
    return;
  }

  size_t frameLen = fb->len;
  httpServer.sendHeader("Content-Type", "image/jpeg");
  httpServer.sendHeader("Content-Length", String(frameLen));
  httpServer.sendHeader("Cache-Control", "no-cache");
  httpServer.send_P(200, "image/jpeg", (const char *)fb->buf, frameLen);
  esp_camera_fb_return(fb);
}

/**
 * Start the WebServer
 */
void setupHTTPServer() {
  httpServer.on("/", HTTP_GET, handleRoot);
  httpServer.on("/stream", HTTP_GET, handleStream);
  httpServer.on("/snapshot", HTTP_GET, handleSnapshot);
  httpServer.begin();
  httpServerStarted = true;
  LOG("[HTTP] Server started on port 80");
}
