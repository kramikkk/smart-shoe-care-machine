/**
 * ===================== WS2812B RGB LED STRIP =====================
 *
 * Controls a 58-LED NeoPixel strip for visual feedback:
 *   rgbColor(r, g, b) — Set all LEDs to a solid color
 *   rgbWhite()        — Full white (classification lighting)
 *   rgbOff()          — All LEDs off
 */

void setRGBColor(int red, int green, int blue) {
  currentRed   = constrain(red,   0, 255);
  currentGreen = constrain(green, 0, 255);
  currentBlue  = constrain(blue,  0, 255);
  uint32_t color = strip.Color(currentRed, currentGreen, currentBlue);
  for (int i = 0; i < RGB_NUM_LEDS; i++) strip.setPixelColor(i, color);
  strip.show();
  LOG("[RGB] " + String(currentRed) + "," + String(currentGreen) + "," + String(currentBlue));
}

void rgbWhite()  { setRGBColor(255, 255, 255); }
void rgbBlue()   { setRGBColor(0,   0,   255); }
void rgbGreen()  { setRGBColor(0,   255, 0);   }
void rgbViolet() { setRGBColor(238, 130, 238); }
void rgbPink()   { setRGBColor(150, 0,   255); }
void rgbOff()    { setRGBColor(0,   0,   0);   }
