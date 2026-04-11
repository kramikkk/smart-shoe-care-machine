/**
 * Payment Handling (Interrupts)
 * Handles pulse counting from coin and bill acceptors.
 */

void IRAM_ATTR handleCoinPulse() {
  if (!paymentEnabled) return;
  if (digitalRead(COIN_SLOT_PIN) != LOW) return;

  unsigned long currentTime = millis();
  portENTER_CRITICAL_ISR(&paymentMux);
  unsigned long enableTime = paymentEnableTime;
  unsigned long processedTime = lastCoinProcessedTime;
  portEXIT_CRITICAL_ISR(&paymentMux);

  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;
  // Ignore pulses that arrive during the guard window after a processed batch.
  // This blocks trailing ghost pulses from the coin mechanism being counted
  // as a new ₱1 coin insertion.
  if (currentTime - processedTime < COIN_GUARD_TIME) return;

  if (currentTime - lastCoinPulseTime > COIN_PULSE_DEBOUNCE_TIME) {
    lastCoinPulseTime = currentTime;
    portENTER_CRITICAL_ISR(&paymentMux);
    currentCoinPulses++;
    portEXIT_CRITICAL_ISR(&paymentMux);
  }
}

void IRAM_ATTR handleBillPulse() {
  if (!paymentEnabled) return;
  if (digitalRead(BILL_PULSE_PIN) != LOW) return;

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
