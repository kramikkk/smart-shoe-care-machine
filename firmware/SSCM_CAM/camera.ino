/*
 * Camera Hardware Initialization and Sensor Configuration
 */

/**
 * Initialize camera hardware and configure sensor parameters
 */
bool camera_init(void) {
  if (is_initialised)
    return true;

  LOG("[CAM:INIT] Initializing camera hardware...");
  esp_err_t err = esp_camera_init(&camera_config);
  if (err != ESP_OK) {
    LOG("[CAM:INIT] Camera init failed with error: " + String(err));
    return false;
  }
  LOG("[CAM:INIT] Camera initialized successfully");

  sensor_t *s = esp_camera_sensor_get();
  if (!s) return false;

  LOG("[CAM:INIT] Sensor PID: 0x" + String(s->id.PID, HEX));

  // OV5640 — primary sensor on the ESP32-S3-EYE module.
  if (s->id.PID == OV5640_PID) {
    LOG("[CAM:INIT] Configuring OV5640 sensor...");
    s->set_vflip(s, 1);    // Module is mounted upside-down on the PCB; flip corrects orientation
    s->set_hmirror(s, 0);  // No horizontal mirror needed for this mount

    // Auto Exposure Control (AEC) — let the sensor adapt to ambient light automatically.
    s->set_exposure_ctrl(s, 1); // 1 = AEC on (automatic)
    s->set_aec2(s, 0);          // AEC2 is the nighttime slow-shutter extension; off for fast capture
    s->set_ae_level(s, 0);      // AEC target offset: 0 = neutral (range -2 to +2)
    s->set_gain_ctrl(s, 1);     // AGC on — sensor auto-adjusts gain with exposure
    s->set_gainceiling(s, GAINCEILING_4X); // Cap gain at 4× to limit noise in low-light captures

    // Auto White Balance (AWB).
    s->set_whitebal(s, 1);  // AWB on
    s->set_awb_gain(s, 1);  // AWB gain correction on
    s->set_wb_mode(s, 0);   // 0 = auto mode (not locked to a preset like daylight/cloudy)

    // Image quality tuning — values chosen for clear shoe texture detail.
    s->set_brightness(s, 0);  // 0 = neutral (range -2 to +2)
    s->set_contrast(s, 1);    // Slightly boosted contrast to distinguish material textures
    s->set_saturation(s, 1);  // Slightly boosted saturation aids colour-based classification
    s->set_sharpness(s, 2);   // Moderate sharpening helps edge detection in Gemini

    s->set_lenc(s, 1);     // Lens shading correction (lenc): compensates lens vignetting
    s->set_bpc(s, 1);      // Bad pixel cancellation: removes hot/dead pixels from the frame
    s->set_wpc(s, 1);      // White pixel correction: similar to BPC for bright defect pixels
    s->set_raw_gma(s, 1);  // Raw gamma correction: linearises sensor response before JPEG encode
  }
  // OV3660 — secondary supported sensor (not present on standard ESP32-S3-EYE, kept for parity).
  else if (s->id.PID == OV3660_PID) {
    LOG("[CAM:INIT] Detected OV3660 sensor, configuring...");
    s->set_vflip(s, 1);        // Same physical orientation assumption
    s->set_brightness(s, 0);
    s->set_ae_level(s, -1);    // Slightly underexposed for OV3660 sensor tuning parity
    s->set_aec2(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1);
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
  }
  // Generic / unknown sensor — conservative defaults that work across OV2640 and similar sensors.
  else {
    LOG("[CAM:INIT] Unknown sensor type, applying generic config...");
    s->set_vflip(s, 1);
    s->set_brightness(s, 0);
    s->set_ae_level(s, -1);
    s->set_aec2(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1);
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
  }

  is_initialised = true;
  LOG("[CAM:INIT] Camera fully initialized and ready");
  return true;
}
