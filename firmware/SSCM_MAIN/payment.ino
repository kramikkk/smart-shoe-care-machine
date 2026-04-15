/**
 * Payment ISR handlers — both run in IRAM to avoid flash cache misses during interrupt.
 * These are called on every falling edge of the coin/bill acceptor output pin.
 * They only count pulses; loop() reads the counts and calculates peso values.
 *
 * Pulse protocol:
 *   Coin: ₱1 = 1 pulse, ₱5 = 5 pulses, ₱10 = 10 pulses (burst within COIN_COMPLETE_TIMEOUT)
 *   Bill: each pulse = ₱10 (₱20 bill = 2 pulses, ₱50 = 5 pulses, ₱100 = 10 pulses)
 */

/**
 * Coin acceptor ISR — counts falling-edge pulses from the coin mechanism.
 * Three guards are applied before counting:
 *   1. paymentEnabled — coins are ignored when payment is not active.
 *   2. PAYMENT_STABILIZATION_DELAY — ignores pulses in the first 100ms after payment
 *      is enabled; relay contact bounce on relay 1 can generate phantom pulses at startup.
 *   3. COIN_GUARD_TIME — dead window after a batch is processed to suppress ghost pulses
 *      that the coin mechanism sometimes emits after the real coin burst.
 */
void IRAM_ATTR handleCoinPulse() {
  if (!paymentEnabled) return;
  if (digitalRead(COIN_SLOT_PIN) != LOW) return; // Extra noise filter: re-check pin is still LOW

  unsigned long currentTime = millis();
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime    = paymentEnableTime;
  unsigned long processedTime = lastCoinProcessedTime;
  portEXIT_CRITICAL_ISR(&paymentMux);

  // Guard 1: stabilisation window after payment enable (relay bounce)
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;
  // Guard 2: dead time after a coin batch was processed (ghost pulse suppression)
  if (currentTime - processedTime < COIN_GUARD_TIME) return;
  // Guard 3: debounce — ignore pulses faster than COIN_PULSE_DEBOUNCE_TIME apart
  if (currentTime - lastCoinPulseTime > COIN_PULSE_DEBOUNCE_TIME) {
    lastCoinPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentCoinPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}

/**
 * Bill acceptor ISR — counts falling-edge pulses from the bill validator.
 * Applies payment-enabled and stabilisation guards (same logic as coin, minus the
 * post-batch guard — bill mechanisms don't produce ghost pulses after acceptance).
 */
void IRAM_ATTR handleBillPulse() {
  if (!paymentEnabled) return;
  if (digitalRead(BILL_PULSE_PIN) != LOW) return;

  unsigned long currentTime = millis();
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  portEXIT_CRITICAL_ISR(&paymentMux);

  // Stabilisation guard: ignore pulses in the first 100ms after payment is enabled
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;

  if (currentTime - lastBillPulseTime > BILL_PULSE_DEBOUNCE_TIME) {
    lastBillPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentBillPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}
