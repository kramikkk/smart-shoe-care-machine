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

  // OV5640 configuration
  if (s->id.PID == OV5640_PID) {
    LOG("[CAM:INIT] Configuring OV5640 sensor...");
    s->set_vflip(s, 1); // Camera mounted upside down
    s->set_hmirror(s, 0);

    // Auto exposure settings
    s->set_exposure_ctrl(s, 1);
    s->set_aec2(s, 0);
    s->set_ae_level(s, 0);
    s->set_gain_ctrl(s, 1);
    s->set_gainceiling(s, GAINCEILING_4X);

    // White balance
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_wb_mode(s, 0);

    // Image quality
    s->set_brightness(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_lenc(s, 1);
    s->set_bpc(s, 1);
    s->set_wpc(s, 1);
    s->set_raw_gma(s, 1);
  }
  // OV3660 fallback branch (Parity)
  else if (s->id.PID == OV3660_PID) {
    LOG("[CAM:INIT] Detected OV3660 sensor, configuring...");
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
  // Generic OV2640 / Unknown fallback branch (Parity)
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
