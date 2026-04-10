/**
 * Machine Service Logic
 * Handles state machines for Cleaning, Drying, and Sterilizing cycles.
 */

/* ===================== START SERVICE ===================== */
void startService(String shoeType, String service, String care,
                  unsigned long customDurationSeconds,
                  long customCleaningDistanceMm) {
  if (serviceActive) {
    return;
  }

  // Set service state
  serviceActive = true;
  currentServiceType = service;
  currentShoeType = shoeType;
  currentCareType = care;
  serviceStartTime = millis();

  // Set duration (seconds -> ms)
  if (customDurationSeconds > 0) {
    serviceDuration = customDurationSeconds * 1000;
  } else {
    // Default durations if not specified by backend
    if (service == "cleaning")
      serviceDuration = 300000; // 5 min
    else if (service == "drying")
      serviceDuration = 600000; // 10 min
    else if (service == "sterilizing")
      serviceDuration = 300000; // 5 min
    else
      serviceDuration = 300000; // 5 min default
  }

  // Safety: ensure all relays off before starting
  allRelaysOff();

  // Mode-specific initial actions
  if (service == "cleaning") {
    cleaningPhase = 1;
    brushCurrentCycle = 0;
    // Initial hardware: Top Linear moves to home position
    LOG("[SERVICE] Cleaning started — homing top linear");
    stepper1MoveTo(CLEANING_MAX_POSITION);
    rgbBlue();
  } else if (service == "drying") {
    LOG("[SERVICE] Drying started — heater and fan ON");
    setRelay(3, true); // Fan ON
    // Heaters will be managed by temperature control loop
    dryingHeaterOn = false;
    dryingExhaustOn = false;
    rgbGreen();
  } else if (service == "sterilizing") {
    LOG("[SERVICE] Sterilizing started — UVC and mist ON");
    setRelay(8, true); // UVC light ON
    setRelay(7, true); // Mist maker ON
    delay(100);
    rgbViolet();
  }

  // Notify backend
  sendServiceStatusUpdate("started");
}

/* ===================== STOP SERVICE ===================== */
void stopService(String reason) {
  if (!serviceActive)
    return;

  LOG("[SERVICE] Service stopped: " + reason);
  serviceActive = false;

  // Turn off all hardware
  allRelaysOff();
  motorsCoast();
  rgbOff();

  // Reset cleaning state
  cleaningPhase = 0;
  brushCurrentCycle = 0;

  // Final actions: enter purge mode if ending naturally or after heating
  if (reason == "completed" || currentServiceType == "drying") {
    LOG("[SERVICE] Entering 15s purge cycle");
    purgeActive = true;
    purgeStartTime = millis();
    purgeServiceType = currentServiceType;
    purgeShoeType = currentShoeType;
    purgeCareType = currentCareType;
    setRelay(2, true); // Bottom Exhaust ON for purge
  }

  // Clear current service info
  currentServiceType = "";
  currentShoeType = "";
  currentCareType = "";

  // Notify backend
  sendServiceStatusUpdate(reason);
}

void stopService() { stopService("aborted"); }

/**
 * Handle purge cycle (exhaust fan cleanup after service)
 * Runs for 15 seconds after drying or sterilizing to vent chamber
 * Prevents condensation and mist accumulation
 */
void handlePurge() {
  if (!purgeActive)
    return;

  if (millis() - purgeStartTime >= PURGE_DURATION_MS) {
    LOG("[SERVICE] Purge complete - exhaust OFF");
    purgeActive = false;
    setRelay(2, false); // Bottom Exhaust OFF

    purgeServiceType = "";
    purgeShoeType = "";
    purgeCareType = "";
  }
}

/**
 * Handle drying temperature control loop
 * Maintains 35-40°C in chamber using PTC heaters and exhaust fan
 */
void handleDryingTemperature() {
  if (!serviceActive || currentServiceType != "drying")
    return;

  if (currentTemperature <= 0.0)
    return; // No valid reading yet

  if (currentTemperature < DRYING_TEMP_LOW) {
    // Too cold — heaters ON, exhaust OFF
    if (!dryingHeaterOn) {
      LOG("[DRYING] Temp " + String(currentTemperature, 1) + "C < " +
          String(DRYING_TEMP_LOW) + "C -> HEAT ON");
      setRelay(4, true); // Left PTC Heater
      setRelay(6, true); // Right PTC Heater
      dryingHeaterOn = true;
    }
    if (dryingExhaustOn) {
      LOG("[DRYING] Exhaust OFF");
      setRelay(2, false);
      dryingExhaustOn = false;
    }
  } else if (currentTemperature > DRYING_TEMP_HIGH) {
    // Too hot — heaters OFF, exhaust ON to release heat
    if (dryingHeaterOn) {
      LOG("[DRYING] Temp " + String(currentTemperature, 1) + "C > " +
          String(DRYING_TEMP_HIGH) + "C -> HEAT OFF");
      setRelay(4, false); // Left PTC Heater
      setRelay(6, false); // Right PTC Heater
      dryingHeaterOn = false;
    }
    if (!dryingExhaustOn) {
      LOG("[DRYING] Exhaust ON to cool chamber");
      setRelay(2, true);
      dryingExhaustOn = true;
    }
  }
}

/**
 * Main service state machine
 * Handles phasing for complex services (like cleaning) and checks duration
 */
void handleService() {
  if (!serviceActive)
    return;

  unsigned long elapsed = millis() - serviceStartTime;

  // Check if service time is up
  if (elapsed >= serviceDuration) {
    stopService("completed");
    return;
  }

  // Periodic status update to backend (every 1s)
  if (millis() - lastServiceStatusUpdate >= SERVICE_STATUS_UPDATE_INTERVAL) {
    lastServiceStatusUpdate = millis();
    sendServiceStatusUpdate("running");
  }

  if (currentServiceType == "cleaning") {
    // ===========================================
    // CLEANING STATE MACHINE
    // ===========================================

    if (cleaningPhase == 1) {
      // Phase 1: Homing top linear and starting side brush movement
      if (!stepper1Moving) {
        LOG("[CLEANING] Top linear home. Starting side move.");
        stepper2MoveTo(STEPPER2_MAX_POSITION);
        cleaningPhase = 2;
        // Start side motors (DRV8871)
        setMotorsSameSpeed(BRUSH_MOTOR_SPEED);
      }
    } else if (cleaningPhase == 2) {
      // Phase 2: Top linear moving downwards (towards brush)
      if (!stepper2Moving) {
        LOG("[CLEANING] Side move complete. Moving top linear to 0.");
        stepper1MoveTo(0);
        cleaningPhase = 3;
        // Turn on pump for soap dispense during descent
        setRelay(5, true);
      }
    } else if (cleaningPhase == 3) {
      // Phase 3: Moving to 0 (descending)
      if (!stepper1Moving) {
        LOG("[CLEANING] Reached bottom. Starting brush cycles.");
        setRelay(5, false); // Pump OFF
        brushPhaseStartTime = millis();
        brushCurrentCycle = 1;
        cleaningPhase = 4; // Start CW brushing
      }
    } else if (cleaningPhase == 4) {
      // Phase 4: Brushing CW
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        LOG("[CLEANING] CW cycle complete. Coasting...");
        motorsCoast();
        brushPhaseStartTime = millis();
        brushNextPhase = 5;
        cleaningPhase = 6; // Entrance to coast transition
      }
    } else if (cleaningPhase == 5) {
      // Phase 5: Brushing CCW
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        LOG("[CLEANING] CCW cycle complete. Coasting...");
        motorsCoast();
        brushPhaseStartTime = millis();
        brushNextPhase = 4;
        brushCurrentCycle++;
        cleaningPhase = 6; // Entrance to coast transition
      }
    } else if (cleaningPhase == 6) {
      // Phase 6: Coast transition (safety wait)
      if (millis() - brushPhaseStartTime >= BRUSH_COAST_MS) {
        // Change direction and enter next phase
        if (brushNextPhase == 4) {
          LOG("[CLEANING] Cycle " + String(brushCurrentCycle) + " -> CW");
          setMotorsSameSpeed(BRUSH_MOTOR_SPEED);
        } else {
          LOG("[CLEANING] Cycle " + String(brushCurrentCycle) + " -> CCW");
          setMotorsSameSpeed(-BRUSH_MOTOR_SPEED);
        }
        brushPhaseStartTime = millis();
        cleaningPhase = brushNextPhase;
      }
    }
  }
}

/* ===================== SEND SERVICE STATUS ===================== */
void sendServiceStatusUpdate(String status) {
  if (!wsConnected)
    return;

  unsigned long elapsed = millis() - serviceStartTime;
  unsigned long remaining =
      (serviceDuration > elapsed) ? (serviceDuration - elapsed) : 0;

  // JSON summary of current service state for cockpit UI
  String msg = "{";
  msg += "\"type\":\"service-status\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"status\":\"" + status + "\",";
  msg += "\"serviceType\":\"" + currentServiceType + "\",";
  msg += "\"shoeType\":\"" + currentShoeType + "\",";
  msg += "\"careType\":\"" + currentCareType + "\",";
  msg += "\"elapsedSeconds\":" + String(elapsed / 1000) + ",";
  msg += "\"remainingSeconds\":" + String(remaining / 1000) + ",";
  msg += "\"durationSeconds\":" + String(serviceDuration / 1000);
  msg += "}";

  webSocket.sendTXT(msg);
}
