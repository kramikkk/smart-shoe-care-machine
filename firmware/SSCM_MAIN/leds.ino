/**
 * RGB LED Control — WS2812B NeoPixel strip (58 LEDs on RGB_DATA_PIN).
 *
 * Service state → colour mapping:
 *   White  — classification preview active (shoe being scanned)
 *   Blue   — cleaning in progress
 *   Green  — drying in progress
 *   Violet — sterilizing in progress
 *   Off    — idle / service complete / payment screen
 *
 * The strip is owned by whichever service is active; classificationLedOn
 * tracks whether the white preview is showing so it can be restored correctly
 * when a service ends.
 */

/**
 * Set all LEDs to the given RGB colour (0–255 per channel).
 * Values are clamped before writing to prevent NeoPixel library out-of-range behaviour.
 */
void setRGBColor(int red, int green, int blue) {
  currentRed   = constrain(red,   0, 255);
  currentGreen = constrain(green, 0, 255);
  currentBlue  = constrain(blue,  0, 255);

  uint32_t color = strip.Color(currentRed, currentGreen, currentBlue);
  for (int i = 0; i < RGB_NUM_LEDS; i++) {
    strip.setPixelColor(i, color);
  }
  strip.show();
}

void rgbWhite()  { setRGBColor(255, 255, 255); } // Classification preview / shoe scan active
void rgbBlue()   { setRGBColor(0,   0,   255); } // Cleaning service active
void rgbGreen()  { setRGBColor(0,   255,   0); } // Drying service active
void rgbViolet() { setRGBColor(150, 0,   255); } // Sterilizing service active
void rgbOff()    { setRGBColor(0,   0,     0); } // Idle or service complete
