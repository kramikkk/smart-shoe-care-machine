/**
 * Machine Service Logic
 * Handles state machines for Cleaning, Drying, and Sterilizing cycles.
 */

static long cleaningSideTargetSteps(const String &care, long customMm) {
  if (customMm > 0) {
    long steps = customMm * STEPPER2_STEPS_PER_MM;
    if (steps > STEPPER2_MAX_POSITION)
      steps = STEPPER2_MAX_POSITION;
    return steps;
  }
  /* STEPPER2_STEPS_PER_MM = 200 → mm = steps/200 (gentle 90, normal 95, strong 100) */
  if (care == "strong")
    return 20000;
  if (care == "normal")
    return 19000;
  if (care == "gentle")
    return 18000;
  return 19000;
}

/** Defaults when client omits duration (seconds × 1000); aligned with app tier defaults. */
static unsigned long defaultServiceDurationMs(const String &svc,
                                              const String &care) {
  if (svc == "cleaning") {
    if (care == "gentle")
      return 60000UL;
    if (care == "normal")
      return 180000UL;
    if (care == "strong")
      return 300000UL;
    return 180000UL;
  }
  if (svc == "drying" || svc == "sterilizing") {
    if (care == "gentle")
      return 60000UL;
    if (care == "normal")
      return 180000UL;
    if (care == "strong")
      return 300000UL;
    return 180000UL;
  }
  return 180000UL;
}

static void sendServiceCompleteMessage(const String &svcType, const String &shoe,
                                       const String &care) {
  if (!wsConnected || !isPaired)
    return;
  String msg = "{\"type\":\"service-complete\",\"deviceId\":\"" + deviceId +
               "\",\"serviceType\":\"" + svcType + "\",\"shoeType\":\"" + shoe +
               "\",\"careType\":\"" + care + "\"}";
  webSocket.sendTXT(msg);
  wsLog("info", "service-complete: " + svcType + " | shoe: " + shoe +
                    " | care: " + care);
}

/** Auto/kiosk: end current stage so the next start-service can run (e375564). */
static void handoverEndPreviousService() {
  if (!serviceActive)
    return;

  String prevType = currentServiceType;
  String prevShoe = currentShoeType;
  String prevCare = currentCareType;

  LOG("[SERVICE] Handover — ending " + prevType + " before next stage");
  motorsCoast();

  if (prevType == "cleaning") {
    setRelay(5, false);
    cleaningPhase = 0;
    brushCurrentCycle = 0;
    stepper1MoveTo(CLEANING_MAX_POSITION);
    stepper2MoveTo(0);
    setServoPositions(0, true);
  } else if (prevType == "drying") {
    dryingHeaterOn = false;
    dryingExhaustOn = false;
  }

  if (purgeActive) {
    purgeActive = false;
    setRelay(2, false);
    purgeServiceType = "";
    purgeShoeType = "";
    purgeCareType = "";
  }

  allRelaysOff();
  rgbOff();

  sendServiceCompleteMessage(prevType, prevShoe, prevCare);
}

/* ===================== START SERVICE ===================== */
void startService(String shoeType, String service, String care,
                  unsigned long customDurationSeconds,
                  long customCleaningDistanceMm) {
  if (serviceActive)
    handoverEndPreviousService();

  // Set service state (stays active across kiosk stage changes)
  serviceActive = true;
  classificationLedOn = false; // Strip owned by service, not classify preview
  currentServiceType = service;
  currentShoeType = shoeType;
  currentCareType = care;
  serviceStartTime = millis();
  lastServiceStatusUpdate = millis();

  // Set duration (seconds -> ms)
  if (customDurationSeconds > 0) {
    serviceDuration = customDurationSeconds * 1000;
  } else {
    serviceDuration = defaultServiceDurationMs(service, care);
  }

  // Safety: ensure all relays off before starting
  allRelaysOff();

  // Mode-specific initial actions
  if (service == "cleaning") {
    cleaningPhase = 1;
    brushCurrentCycle = 0;
    long s2 = cleaningSideTargetSteps(care, customCleaningDistanceMm);
    LOG("[SERVICE] Cleaning — pump ON; side→" + String(s2) +
        " steps + top 480→0→480 simultaneously (top reverses at 0, no side wait); then brush+servo");
    setRelay(5, true); // Diaphragm pump — on for approach + oscillation until top home
    stepper2MoveTo(s2);       // side brush moves to cleaning depth
    stepper1MoveTo(0);        // top brush descends simultaneously (was CLEANING_MAX_POSITION no-op)
    brushPhaseStartTime = millis();
    rgbBlue();
  } else if (service == "drying") {
    LOG("[SERVICE] Drying — fan + PTC on; temp loop cools if >40C");
    setRelay(3, true); // Fan ON
    setRelay(4, true); // Left PTC ON (handleDryingTemperature may cycle off)
    setRelay(6, true); // Right PTC ON
    dryingHeaterOn = true;
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
  String endedServiceType = currentServiceType;
  serviceActive = false;

  // Turn off all hardware
  allRelaysOff();
  motorsCoast();

  // Park top/side/servos only when cleaning ends (dry/steril do not move linear axes)
  if (endedServiceType == "cleaning") {
    stepper1MoveTo(CLEANING_MAX_POSITION);
    stepper2MoveTo(0);
    setServoPositions(0, true);
  }

  rgbOff();

  // Reset cleaning state
  cleaningPhase = 0;
  brushCurrentCycle = 0;

  String endedShoe = currentShoeType;
  String endedCare = currentCareType;

  // Legacy: purge after drying or sterilizing on completed OR aborted
  if (endedServiceType == "drying" || endedServiceType == "sterilizing") {
    LOG("[SERVICE] Entering 15s purge (" + reason + ")");
    purgeActive = true;
    purgeStartTime = millis();
    purgeServiceType = endedServiceType;
    purgeShoeType = endedShoe;
    purgeCareType = endedCare;
    setRelay(2, true); // Bottom Exhaust ON for purge
  }

  sendServiceCompleteMessage(endedServiceType, endedShoe, endedCare);

  // Keep current* populated for this payload
  sendServiceStatusUpdate(reason);

  currentServiceType = "";
  currentShoeType = "";
  currentCareType = "";
}

void stopService() { stopService("aborted"); }

/**
 * Handle purge cycle (exhaust fan cleanup after service)
 * Runs for 15s after drying or sterilizing ends (completed or aborted).
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
  // Between DRYING_TEMP_LOW and DRYING_TEMP_HIGH: no change (hysteresis band).
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

  if (currentServiceType == "cleaning" && cleaningPhase > 0) {
    // Phase 1: pump ON — side and top start simultaneously (startService sends both).
    //          Top does a full 480→0→480 round trip independently:
    //          the moment top reaches 0 it immediately reverses — it does NOT wait for side.
    // Phase 2: top returning 0→480 (pump still ON). The moment top hits 480 → pump OFF.
    // Phase 3: wait for side to reach cleaning depth, then start CW/CCW brush + servo sweep.
    // Phase 4+: CW/CCW brushes + coast transitions.

    if (cleaningPhase == 1) {
      if (!stepper1Moving) {
        // Top reached 0 — immediately reverse upward (pump still ON).
        // Side linear continues moving to its depth independently.
        LOG("[CLEANING] Top at 0 — reversing 0→480mm (pump still ON); side still moving");
        cleaningPhase = 2;
        stepper1MoveTo(CLEANING_MAX_POSITION);
      }
    } else if (cleaningPhase == 2) {
      if (!stepper1Moving) {
        // Top is back at 480mm — pump OFF immediately. Side may still be moving.
        LOG("[CLEANING] Top at 480 — pump OFF; waiting for side to reach depth");
        setRelay(5, false);
        cleaningPhase = 3;
      }
    } else if (cleaningPhase == 3) {
      if (!stepper2Moving) {
        // Side at cleaning depth — start brush + servo sweep
        LOG("[CLEANING] Side at depth — start brush + servo sweep");
        cleaningPhase = 4;
        brushCurrentCycle = 1;
        brushPhaseStartTime = millis();
        setMotorsSameSpeed(BRUSH_MOTOR_SPEED);

        unsigned long elapsedSoFar = millis() - serviceStartTime;
        unsigned long remainingMs =
            (elapsedSoFar < serviceDuration) ? (serviceDuration - elapsedSoFar) : 1UL;
        int dynInterval = (int)((remainingMs / 15UL) / 180UL);
        if (dynInterval < 1)
          dynInterval = 1;
        setServoPositions(180, false);
        servoStepInterval = dynInterval;
      }
    } else if (cleaningPhase == 4) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        LOG("[CLEANING] CW segment done — coast");
        motorsCoast();
        cleaningPhase = 6;
        brushNextPhase = 5;
        brushPhaseStartTime = millis();
      }
    } else if (cleaningPhase == 5) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        brushCurrentCycle++;
        if (brushCurrentCycle > BRUSH_TOTAL_CYCLES) {
          LOG("[CLEANING] Brush cycle cap — stopping");
          motorsCoast();
          cleaningPhase = 0;
          brushCurrentCycle = 0;
          stopService("completed");
          return;
        }
        LOG("[CLEANING] CCW segment done — coast");
        motorsCoast();
        cleaningPhase = 6;
        brushNextPhase = 4;
        brushPhaseStartTime = millis();
      }
    } else if (cleaningPhase == 6) {
      if (millis() - brushPhaseStartTime >= BRUSH_COAST_MS) {
        cleaningPhase = brushNextPhase;
        brushPhaseStartTime = millis();
        if (brushNextPhase == 5) {
          LOG("[CLEANING] → CCW");
          setMotorsSameSpeed(-BRUSH_MOTOR_SPEED);
        } else {
          LOG("[CLEANING] → CW");
          setMotorsSameSpeed(BRUSH_MOTOR_SPEED);
        }
      }
    }
  }
}

/* ===================== SEND SERVICE STATUS ===================== */
void sendServiceStatusUpdate(String status) {
  if (!wsConnected)
    return;

  unsigned long elapsedMs = millis() - serviceStartTime;
  unsigned long remainingMs =
      (serviceDuration > elapsedMs) ? (serviceDuration - elapsedMs) : 0;
  unsigned long elapsedSec = elapsedMs / 1000;
  unsigned long remainingSec = remainingMs / 1000;

  int progressPct = 0;
  if (serviceDuration > 0) {
    progressPct = (int)((elapsedMs * 100UL) / serviceDuration);
    if (progressPct > 100)
      progressPct = 100;
  }

  bool active = (status == "started" || status == "running");

  // New fields + legacy (e375564) progress / timeRemaining / active for dashboard
  String msg = "{";
  msg += "\"type\":\"service-status\",";
  msg += "\"deviceId\":\"" + deviceId + "\",";
  msg += "\"status\":\"" + status + "\",";
  msg += "\"serviceType\":\"" + currentServiceType + "\",";
  msg += "\"shoeType\":\"" + currentShoeType + "\",";
  msg += "\"careType\":\"" + currentCareType + "\",";
  msg += "\"elapsedSeconds\":" + String(elapsedSec) + ",";
  msg += "\"remainingSeconds\":" + String(remainingSec) + ",";
  msg += "\"durationSeconds\":" + String(serviceDuration / 1000) + ",";
  msg += "\"progress\":" + String(progressPct) + ",";
  msg += "\"timeRemaining\":" + String(remainingSec) + ",";
  msg += "\"active\":" + String(active ? "true" : "false");
  msg += "}";

  webSocket.sendTXT(msg);
}

/** WebSocket stop-service while post-dry/steril purge is running (serviceActive is false). */
void abortPurgeIfActive() {
  if (!purgeActive)
    return;
  LOG("[SERVICE] Purge aborted (stop-service)");
  purgeActive = false;
  setRelay(2, false);
  purgeServiceType = "";
  purgeShoeType = "";
  purgeCareType = "";
}
