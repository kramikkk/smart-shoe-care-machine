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
  portEXIT_CRITICAL_ISR(&paymentMux);
  if (currentTime - enableTime < PAYMENT_STABILIZATION_DELAY) return;

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
