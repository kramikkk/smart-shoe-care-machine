/*
 * HTTP Server for Live Streaming and Snapshots
 * Serves three endpoints on port 80:
 *   GET /          — status page with device info and links
 *   GET /stream    — MJPEG live stream (multipart/x-mixed-replace)
 *   GET /snapshot  — single JPEG capture
 * Used for diagnostics and manual verification; not part of the normal service flow.
 */

// MJPEG multipart boundary string — separates individual JPEG frames in the stream response.
#define PART_BOUNDARY "frameboundary"

/**
 * Root status page — shows current device state and links to stream/snapshot.
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
 * MJPEG live stream handler.
 * Sends an infinite multipart/x-mixed-replace response where each part is a JPEG frame.
 * The browser renders this as a live video feed without JavaScript.
 * Stream is capped at 60s to prevent long-lived connections starving the rest of loop().
 */
void handleStream() {
  WiFiClient client = httpServer.client();
  unsigned long streamStartMs = millis();
  const unsigned long STREAM_TIMEOUT_MS = 60000; // Hard cutoff: disconnect after 60s

  client.print("HTTP/1.1 200 OK\r\n");
  client.print("Content-Type: multipart/x-mixed-replace; boundary=" PART_BOUNDARY "\r\n");
  client.print("Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n");

  while (client.connected()) {
    yield(); // Feed the watchdog timer and allow other ESP32 tasks to run between frames

    // Classification takes priority over streaming — stop sending frames so the camera
    // buffer is free and the next esp_camera_fb_get() in captureAndPostToBackend() gets
    // a fresh, undisturbed frame.
    if (classificationRequested) break;

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
    delay(50); // Cap at ~20 FPS; higher rates saturate the TCP send buffer
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
