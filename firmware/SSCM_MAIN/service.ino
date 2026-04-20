/**
 * Machine Service Logic
 * Handles the state machines for Cleaning, Drying, and Sterilizing cycles.
 *
 * Cleaning state machine (cleaningPhase):
 *   0 — Idle / not cleaning
 *   1 — Pump ON; top brush descends (0→480 steps) and side brush advances to cleaning depth simultaneously
 *   2 — Top brush reversing (0→480 steps) with pump still ON; waiting for top to reach park position
 *   3 — Top at park (480 steps); pump OFF; waiting for side to reach its cleaning depth
 *   4 — CW brush rotation active for BRUSH_DURATION_MS
 *   5 — CCW brush rotation active for BRUSH_DURATION_MS; increments brushCurrentCycle counter
 *   6 — Coast gap between CW and CCW segments for BRUSH_COAST_MS; brushNextPhase queues next phase
 */

/**
 * Calculate how far the side brush (Stepper 2) should travel for a cleaning pass.
 * customMm > 0: use the dashboard-specified distance, clamped to the physical rail limit.
 * customMm == 0: use the care-level default:
 *   gentle → 18000 steps (90mm), normal → 19000 steps (95mm), strong → 20000 steps (100mm)
 * STEPPER2_STEPS_PER_MM = 200, so steps / 200 = mm of brush penetration.
 */
static long cleaningSideTargetSteps(const String &care, long customMm) {
  if (customMm > 0) {
    long steps = customMm * STEPPER2_STEPS_PER_MM;
    if (steps > STEPPER2_MAX_POSITION)
      steps = STEPPER2_MAX_POSITION; // Never exceed physical rail end stop (100mm)
    return steps;
  }
  if (care == "strong")  return 20000; // 100mm
  if (care == "normal")  return 19000; // 95mm
  if (care == "gentle")  return 18000; // 90mm
  return 19000; // Default to normal if care level is unrecognised
}

/**
 * Return the default service duration (ms) when the start-service command omits duration.
 * Tiers mirror the app's pricing/time display so the machine behaves consistently:
 *   gentle → 180s (3 min), normal → 360s (6 min), strong → 540s (9 min)
 * All three service types use the same tier mapping.
 */
static unsigned long defaultServiceDurationMs(const String &svc,
                                              const String &care) {
  if (svc == "cleaning" || svc == "drying" || svc == "sterilizing") {
    if (care == "gentle") return 180000UL; //  3 minutes
    if (care == "normal") return 360000UL; //  6 minutes
    if (care == "strong") return 540000UL; //  9 minutes
    return 360000UL; // Default to normal
  }
  return 360000UL;
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

/**
 * End the currently active service stage so the next start-service command can run cleanly.
 * Used in auto/kiosk mode where the kiosk tablet sends consecutive start-service WS messages
 * (e.g. cleaning → drying) without an explicit stop-service in between.
 * Sends service-complete for the outgoing stage and resets all actuators.
 */
static void handoverEndPreviousService() {
  if (!serviceActive)
    return;

  String prevType = currentServiceType;
  String prevShoe = currentShoeType;
  String prevCare = currentCareType;

  LOG("[SERVICE] Handover — ending " + prevType + " before next stage");
  motorsCoast();

  if (prevType == "cleaning") {
    setRelay(5, false); // Pump OFF
    cleaningPhase = 0;
    brushCurrentCycle = 0;
    stepper1MoveTo(CLEANING_MAX_POSITION); // Park top brush at 48mm
    stepper2MoveTo(0);                     // Retract side brush
    setServoPositions(0, true);
  } else if (prevType == "drying") {
    dryingHeaterOn   = false;
    dryingExhaustOn  = false;
  }

  // Cancel any running post-service purge so the next service starts clean.
  if (purgeActive) {
    purgeActive = false;
    setRelay(2, false); // Bottom exhaust OFF
    purgeServiceType = "";
    purgeShoeType    = "";
    purgeCareType    = "";
  }

  allRelaysOff();
  rgbOff();

  sendServiceCompleteMessage(prevType, prevShoe, prevCare);
}

/* ===================== START SERVICE ===================== */

/**
 * Begin a service cycle.
 * shoeType: "mesh", "canvas", or "rubber" (from classification result)
 * service:  "cleaning", "drying", or "sterilizing"
 * care:     "gentle", "normal", or "strong"
 * customDurationSeconds: 0 = use tier default; >0 = override in seconds
 * customCleaningDistanceMm: -1 = use care-level default; >0 = override in mm
 * customMotorSpeedPwm: -1 = keep current brushMotorSpeed; 0–255 = override PWM for brush motors
 *
 * If a service is already active (kiosk multi-stage flow), handoverEndPreviousService()
 * cleanly terminates the prior stage before this one begins.
 */
void startService(String shoeType, String service, String care,
                  unsigned long customDurationSeconds,
                  long customCleaningDistanceMm,
                  int customMotorSpeedPwm,
                  float customDryingTempSetpoint) {
  if (serviceActive)
    handoverEndPreviousService();

  // Apply dashboard motor speed override; -1 means leave at current value (default 255).
  if (customMotorSpeedPwm >= 0 && customMotorSpeedPwm <= 255)
    brushMotorSpeed = customMotorSpeedPwm;

  // Apply dashboard drying temp setpoint; -1 means keep current value (default 40°C).
  if (customDryingTempSetpoint >= 30.0 && customDryingTempSetpoint <= 50.0)
    dryingTempSetpoint = customDryingTempSetpoint;

  serviceActive       = true;
  classificationLedOn = false; // LED strip is now owned by the service, not the classify preview
  currentServiceType  = service;
  currentShoeType     = shoeType;
  currentCareType     = care;
  serviceStartTime        = millis();
  lastServiceStatusUpdate = millis();

  // customDurationSeconds > 0 is a dashboard override; 0 means use care-tier default.
  serviceDuration = (customDurationSeconds > 0)
      ? customDurationSeconds * 1000
      : defaultServiceDurationMs(service, care);

  allRelaysOff(); // Guarantee all actuators are off before enabling service-specific ones

  if (service == "cleaning") {
    // Phase 1: pump on immediately while both linear axes start moving simultaneously.
    //   - Stepper 2 (side brush) advances to cleaning depth.
    //   - Stepper 1 (top brush) descends from park (480 steps) to 0.
    //   The top brush immediately reverses to 480 once it reaches 0 (phase 2 in handleService).
    //   The pump stays on through phases 1 and 2; it cuts off when the top returns to park.
    cleaningPhase     = 1;
    brushCurrentCycle = 0;
    long s2 = cleaningSideTargetSteps(care, customCleaningDistanceMm);
    LOG("[SERVICE] Cleaning — pump ON; side→" + String(s2) +
        " steps + top 480→0→480 simultaneously (top reverses at 0, no side wait); then brush+servo");
    setRelay(5, true);      // Diaphragm pump ON — spray nozzle active during approach
    stepper2MoveTo(s2);     // Side brush advances to cleaning depth
    stepper1MoveTo(0);      // Top brush descends to bottom of stroke
    brushPhaseStartTime = millis();
    rgbBlue();

  } else if (service == "drying") {
    // All drying actuators start together; handleDryingTemperature() will cycle the PTC
    // heaters and exhaust fan to maintain the 30–45°C target band.
    LOG("[SERVICE] Drying — fan + PTC on; setpoint " + String(dryingTempSetpoint) + "C");
    setRelay(3, true); // Drying fan ON
    setRelay(4, true); // Left PTC heater ON  (may be cycled off by temperature loop)
    setRelay(6, true); // Right PTC heater ON (may be cycled off by temperature loop)
    dryingHeaterOn  = true;
    dryingExhaustOn = false;
    rgbGreen();

  } else if (service == "sterilizing") {
    // UVC and mist maker start together; brief 100ms delay lets the mist
    // maker's ultrasonic element stabilise before the first moisture reading.
    LOG("[SERVICE] Sterilizing started — UVC and mist ON");
    setRelay(8, true); // UVC light ON
    setRelay(7, true); // Mist maker (ultrasonic atomiser) ON
    delay(100);        // Let mist maker element stabilise
    rgbViolet();
  }

  sendServiceStatusUpdate("started"); // Notify backend; kiosk displays active service UI
}

/* ===================== STOP SERVICE ===================== */

/**
 * Terminate the active service cycle.
 * reason: "completed" (timer elapsed), "aborted" (stop-service WS command or cycle cap).
 *
 * Post-service behaviour:
 *   - Cleaning: parks all linear axes (top at 48mm, side retracted) and servos.
 *   - Drying / Sterilizing: starts a PURGE_DURATION_MS exhaust fan purge to clear
 *     residual heat or mist from the chamber before the next use.
 *
 * current* fields are kept populated until after the status payload is sent
 * so sendServiceStatusUpdate() includes the correct service metadata.
 */
void stopService(String reason) {
  if (!serviceActive)
    return;

  LOG("[SERVICE] Service stopped: " + reason);
  String endedServiceType = currentServiceType;
  serviceActive = false;

  allRelaysOff();
  motorsCoast();

  // Return linear axes and servos to their parked/home positions after cleaning.
  // Drying and sterilizing do not use the linear axes, so no park move is needed.
  if (endedServiceType == "cleaning") {
    stepper1MoveTo(CLEANING_MAX_POSITION); // Park top brush at 48mm
    stepper2MoveTo(0);                     // Retract side brush
    setServoPositions(0, true);
  }

  rgbOff();

  cleaningPhase     = 0;
  brushCurrentCycle = 0;

  String endedShoe = currentShoeType;
  String endedCare = currentCareType;

  // Drying and sterilizing both require a post-service exhaust purge:
  //   - Drying: clears residual heat so the next shoe isn't pre-heated.
  //   - Sterilizing: exhausts any remaining chemical mist before the door opens.
  // Purge runs for PURGE_DURATION_MS (15s) regardless of completion or abort.
  if (endedServiceType == "drying" || endedServiceType == "sterilizing") {
    LOG("[SERVICE] Entering " + String(PURGE_DURATION_MS / 1000) + "s purge (" + reason + ")");
    purgeActive      = true;
    purgeStartTime   = millis();
    purgeServiceType = endedServiceType;
    purgeShoeType    = endedShoe;
    purgeCareType    = endedCare;
    setRelay(2, true); // Bottom exhaust fan ON for purge
  }

  sendServiceCompleteMessage(endedServiceType, endedShoe, endedCare);

  // Send status with current* still populated so the payload includes service metadata.
  sendServiceStatusUpdate(reason);

  currentServiceType = "";
  currentShoeType    = "";
  currentCareType    = "";
}

/** Convenience overload: abort without specifying a reason. */
void stopService() { stopService("aborted"); }

/**
 * Non-blocking purge cycle handler — called in loop() after drying or sterilizing ends.
 * Runs the bottom exhaust fan (relay 2) for PURGE_DURATION_MS (15s) to clear
 * residual heat/mist from the chamber before the door is safe to open.
 * serviceActive is false during the purge; abortPurgeIfActive() can cut it early
 * if the dashboard sends a stop-service command while the purge is running.
 */
void handlePurge() {
  if (!purgeActive)
    return;

  if (millis() - purgeStartTime >= PURGE_DURATION_MS) {
    LOG("[SERVICE] Purge complete — exhaust OFF");
    purgeActive = false;
    setRelay(2, false); // Bottom exhaust fan OFF

    purgeServiceType = "";
    purgeShoeType    = "";
    purgeCareType    = "";
  }
}

/**
 * Drying temperature control loop — called in loop() during drying service.
 *
 * Single threshold at dryingTempSetpoint (40°C):
 *   ≤ 40°C → heaters ON,  exhaust OFF  (heating up to target)
 *   > 40°C → heaters OFF, exhaust ON   (venting excess heat; blower stays on throughout)
 *
 * Blower (relay 3) is started at service begin and runs continuously — not toggled here.
 * Returns early if no valid DHT11 reading is available (temperature ≤ 0.0°C).
 */
void handleDryingTemperature() {
  if (!serviceActive || currentServiceType != "drying")
    return;

  if (currentTemperature <= 0.0)
    return; // DHT11 not yet read or sensor error — skip until a valid reading arrives

  if (currentTemperature <= dryingTempSetpoint) {
    // Below or at target — heaters ON, exhaust OFF
    if (!dryingHeaterOn) {
      LOG("[DRYING] Temp " + String(currentTemperature, 1) + "C <= " +
          String(dryingTempSetpoint) + "C -> HEAT ON, EXHAUST OFF");
      setRelay(4, true);  // Left PTC heater ON
      setRelay(6, true);  // Right PTC heater ON
      setRelay(2, false); // Exhaust OFF
      dryingHeaterOn  = true;
      dryingExhaustOn = false;
    }
  } else {
    // Above target — heaters OFF, exhaust ON
    if (dryingHeaterOn || !dryingExhaustOn) {
      LOG("[DRYING] Temp " + String(currentTemperature, 1) + "C > " +
          String(dryingTempSetpoint) + "C -> HEAT OFF, EXHAUST ON");
      setRelay(4, false); // Left PTC heater OFF
      setRelay(6, false); // Right PTC heater OFF
      setRelay(2, true);  // Exhaust ON
      dryingHeaterOn  = false;
      dryingExhaustOn = true;
    }
  }
}

/**
 * Main service state machine — called every loop() iteration.
 * Handles the duration timer, periodic backend heartbeats, and the
 * multi-phase cleaning sequence. Drying and sterilizing are relay/timer
 * services managed entirely by handleDryingTemperature() and the duration check here.
 *
 * Cleaning phase transitions (cleaningPhase is set in startService and updated here):
 *   1 → 2: stepper1 reaches 0 (bottom)  — reverse top upward; pump still ON
 *   2 → 3: stepper1 reaches 480 (top)   — pump OFF; wait for side to reach depth
 *   3 → 4: stepper2 stops moving        — side at depth; start CW brush + servo sweep
 *   4 → 6: BRUSH_DURATION_MS elapsed    — CW done; coast; queue phase 5
 *   5 → 6: BRUSH_DURATION_MS elapsed    — CCW done; coast; queue phase 4 (or stop if cap hit)
 *   6 → 4/5: BRUSH_COAST_MS elapsed     — coast gap over; resume CW or CCW per brushNextPhase
 */
void handleService() {
  if (!serviceActive)
    return;

  unsigned long elapsed = millis() - serviceStartTime;

  // Duration check: stop as "completed" when the service timer expires.
  if (elapsed >= serviceDuration) {
    stopService("completed");
    return;
  }

  // Send a running heartbeat to the backend every SERVICE_STATUS_UPDATE_INTERVAL (1s).
  // This keeps the dashboard progress bar and timer display current.
  if (millis() - lastServiceStatusUpdate >= SERVICE_STATUS_UPDATE_INTERVAL) {
    lastServiceStatusUpdate = millis();
    sendServiceStatusUpdate("running");
  }

  if (currentServiceType == "cleaning" && cleaningPhase > 0) {

    if (cleaningPhase == 1) {
      if (!stepper1Moving) {
        // Top brush reached 0 (bottom of stroke) — immediately reverse.
        // Side brush is still moving to its cleaning depth independently.
        // Pump stays ON through the return journey (phase 2).
        LOG("[CLEANING] Top at 0 — reversing 0→480 steps (pump still ON); side still moving");
        cleaningPhase = 2;
        stepper1MoveTo(CLEANING_MAX_POSITION); // Reverse: return top brush to park
      }

    } else if (cleaningPhase == 2) {
      if (!stepper1Moving) {
        // Top brush returned to park (480 steps) — pump OFF.
        // Side brush may still be advancing; phase 3 waits for it to stop.
        LOG("[CLEANING] Top at 480 steps — pump OFF; waiting for side to reach depth");
        setRelay(5, false); // Diaphragm pump OFF
        cleaningPhase = 3;
      }

    } else if (cleaningPhase == 3) {
      if (!stepper2Moving) {
        // Side brush reached its cleaning depth — begin CW brush rotation and servo sweep.
        // The servo sweep interval is calculated dynamically from the remaining service time
        // so the sweep completes in the same time as the brush cycles.
        LOG("[CLEANING] Side at depth — start brush + servo sweep");
        cleaningPhase     = 4;
        brushCurrentCycle = 1;
        brushPhaseStartTime = millis();
        setMotorsOppositeSpeed(brushMotorSpeed); // Left CW / right CCW

        // Dynamic servo interval: distribute remaining time evenly across 180 steps.
        // dynInterval (ms/step) = remaining_ms / 15 cycles / 180 degrees.
        // Minimum 1ms/step prevents division yielding 0.
        unsigned long elapsedSoFar = millis() - serviceStartTime;
        unsigned long remainingMs  = (elapsedSoFar < serviceDuration)
            ? (serviceDuration - elapsedSoFar) : 1UL;
        int dynInterval = (int)((remainingMs / 15UL) / 180UL);
        if (dynInterval < 1) dynInterval = 1;
        setServoPositions(180, false); // Start sweep toward 180°
        servoStepInterval = dynInterval;
      }

    } else if (cleaningPhase == 4) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        // CW segment complete — coast before reversing to protect motor and gears.
        LOG("[CLEANING] CW segment done — coast");
        motorsCoast();
        cleaningPhase   = 6;   // Enter coast gap
        brushNextPhase  = 5;   // Next active phase is CCW
        brushPhaseStartTime = millis();
      }

    } else if (cleaningPhase == 5) {
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        brushCurrentCycle++;
        if (brushCurrentCycle > BRUSH_TOTAL_CYCLES) {
          // All CW+CCW pairs completed — stop service regardless of remaining time.
          LOG("[CLEANING] Brush cycle cap (" + String(BRUSH_TOTAL_CYCLES) + ") reached — stopping");
          motorsCoast();
          cleaningPhase     = 0;
          brushCurrentCycle = 0;
          stopService("completed");
          return;
        }
        // CCW segment complete — coast, then queue CW for the next cycle.
        LOG("[CLEANING] CCW segment done — coast (cycle " + String(brushCurrentCycle) + "/" + String(BRUSH_TOTAL_CYCLES) + ")");
        motorsCoast();
        cleaningPhase   = 6;   // Enter coast gap
        brushNextPhase  = 4;   // Next active phase is CW
        brushPhaseStartTime = millis();
      }

    } else if (cleaningPhase == 6) {
      if (millis() - brushPhaseStartTime >= BRUSH_COAST_MS) {
        // Coast gap elapsed — resume the next brush direction.
        cleaningPhase = brushNextPhase;
        brushPhaseStartTime = millis();
        if (brushNextPhase == 5) {
          LOG("[CLEANING] → CCW");
          setMotorsOppositeSpeed(-brushMotorSpeed); // Left CCW / right CW
        } else {
          LOG("[CLEANING] → CW");
          setMotorsOppositeSpeed(brushMotorSpeed); // Left CW / right CCW
        }
      }
    }
  }
}

/* ===================== SEND SERVICE STATUS ===================== */

/**
 * Send a service-status payload to the backend WebSocket.
 * status: "started", "running", "completed", "aborted", or any stop reason string.
 *
 * Payload fields:
 *   elapsedSeconds / remainingSeconds — raw time values for custom display
 *   durationSeconds                   — total configured duration for the progress bar denominator
 *   progress (0–100)                  — percentage for the dashboard progress ring
 *   timeRemaining                     — alias of remainingSeconds (legacy dashboard field)
 *   active (bool)                     — true while service is running; false when stopped/completed
 */
void sendServiceStatusUpdate(String status) {
  if (!wsConnected)
    return;

  unsigned long elapsedMs  = millis() - serviceStartTime;
  unsigned long remainingMs = (serviceDuration > elapsedMs) ? (serviceDuration - elapsedMs) : 0;
  unsigned long elapsedSec  = elapsedMs / 1000;
  unsigned long remainingSec = remainingMs / 1000;

  int progressPct = 0;
  if (serviceDuration > 0) {
    progressPct = (int)((elapsedMs * 100UL) / serviceDuration);
    if (progressPct > 100) progressPct = 100; // Cap at 100% in case of minor timer overshoot
  }

  bool active = (status == "started" || status == "running");

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
  msg += "\"timeRemaining\":" + String(remainingSec) + ","; // Legacy alias kept for dashboard compatibility
  msg += "\"active\":" + String(active ? "true" : "false");
  msg += "}";

  webSocket.sendTXT(msg);
}

/**
 * Cancel the post-service purge cycle early.
 * Called when a stop-service WS command arrives while serviceActive is false
 * but purgeActive is true (the exhaust fan is still running after drying/sterilizing).
 * This is the only safe path to abort a purge without stopping a live service.
 */
void abortPurgeIfActive() {
  if (!purgeActive)
    return;
  LOG("[SERVICE] Purge aborted (stop-service)");
  purgeActive = false;
  setRelay(2, false); // Bottom exhaust fan OFF
  purgeServiceType = "";
  purgeShoeType    = "";
  purgeCareType    = "";
}
