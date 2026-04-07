/**
 * ===================== PAYMENT INTERRUPT HANDLERS =====================
 *
 * Coin and bill acceptors generate falling-edge pulses on GPIO pins.
 * Each pulse = 1 unit (coin: PHP 1, bill: 1 pulse = PHP 10).
 *
 * IMPORTANT ISR CONSTRAINTS:
 *   - IRAM_ATTR: Code must reside in IRAM (not flash) for safe ISR execution.
 *   - No LOG()/Serial: Serial is NOT safe inside ISRs (not in IRAM on S3).
 *   - No digitalRead(): Also not guaranteed IRAM-safe on ESP32-S3.
 *   - Pulse counting only: Actual PHP conversion happens in loop().
 *
 * STABILIZATION DELAY:
 *   When relays switch (especially the bill acceptor relay), electromagnetic
 *   interference (EMI) can cause phantom pulses on signal lines. The 3-second
 *   delay after paymentEnableTime gates out these false triggers.
 */

// Coin acceptor ISR — 1 pulse per PHP 1 coin
void IRAM_ATTR handleCoinPulse() {
  if (!paymentEnabled) return;

  unsigned long currentTime = millis();

  // Read paymentEnableTime atomically (shared with loop() on core 1)
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  portEXIT_CRITICAL_ISR(&paymentMux);

  // Ignore pulses during EMI stabilization window after relay switch
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;

  // Software debounce: reject pulses arriving faster than physically possible
  if (currentTime - lastCoinPulseTime > COIN_PULSE_DEBOUNCE_TIME) {
    lastCoinPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentCoinPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}

// Bill acceptor ISR — 1 pulse per PHP 10 bill
void IRAM_ATTR handleBillPulse() {
  if (!paymentEnabled) return;

  unsigned long currentTime = millis();

  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  portEXIT_CRITICAL_ISR(&paymentMux);

  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;

  if (currentTime - lastBillPulseTime > BILL_PULSE_DEBOUNCE_TIME) {
    lastBillPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentBillPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}
