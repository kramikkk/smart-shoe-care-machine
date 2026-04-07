/* ===================== SERVICE FUNCTIONS ===================== */

void startService(String shoeType, String serviceType, String careType,
                  unsigned long customDurationSeconds,
                  long customCleaningDistanceMm) {
  // If a service is already running, complete it cleanly before starting new one
  if (serviceActive) {
    if (wsConnected && isPaired) {
      String msg = "{\"type\":\"service-complete\",\"deviceId\":\"" + deviceId +
                   "\",\"serviceType\":\"" + currentServiceType +
                   "\",\"shoeType\":\"" + currentShoeType +
                   "\",\"careType\":\"" + currentCareType + "\"}";
      webSocket.sendTXT(msg);
    }
    rgbOff();
    setRelay(2, false);
    setRelay(3, false);
    setRelay(4, false);
    setRelay(5, false);
    setRelay(6, false);
    setRelay(7, false);
    setRelay(8, false);

    if (currentServiceType == "cleaning") {
      setRelay(5, false);
      cleaningPhase = 0;
      brushCurrentCycle = 0;
      stepper1MoveTo(CLEANING_MAX_POSITION);
      stepper2MoveTo(0);
      motorsCoast();
    }
  }

  // Determine service duration
  if (serviceType == "cleaning") {
    serviceDuration = 300000;
  } else if (serviceType == "drying" || serviceType == "sterilizing") {
    if      (careType == "gentle") serviceDuration = 60000;
    else if (careType == "strong") serviceDuration = 300000;
    else                           serviceDuration = 180000; // normal / default
  } else {
    serviceDuration = 180000;
  }

  if (customDurationSeconds > 0) {
    serviceDuration = customDurationSeconds * 1000;
  }

  currentShoeType    = shoeType;
  currentServiceType = serviceType;
  currentCareType    = careType;
  serviceActive      = true;
  serviceStartTime   = millis();
  lastServiceStatusUpdate = millis();

  // RGB color per service type
  if      (serviceType == "cleaning")    rgbBlue();
  else if (serviceType == "drying")      rgbGreen();
  else if (serviceType == "sterilizing") rgbPink();

  // Start hardware for each service type
  if (serviceType == "cleaning") {
    long stepper2TargetSteps = 0;
    if (customCleaningDistanceMm > 0) {
      stepper2TargetSteps = customCleaningDistanceMm * STEPPER2_STEPS_PER_MM;
      if (stepper2TargetSteps > STEPPER2_MAX_POSITION)
        stepper2TargetSteps = STEPPER2_MAX_POSITION;
    } else if (careType == "strong") {
      stepper2TargetSteps = 20000;
    } else if (careType == "gentle") {
      stepper2TargetSteps = 18600;
    } else {
      stepper2TargetSteps = 19600; // normal / default
    }
    stepper2MoveTo(stepper2TargetSteps);

    cleaningPhase = 1;
    stepper1MoveTo(CLEANING_MAX_POSITION);
    brushPhaseStartTime = millis();

  } else if (serviceType == "drying") {
    setRelay(3, true); // Blower Fan
    setRelay(4, true); // Left PTC Heater
    setRelay(6, true); // Right PTC Heater
    dryingHeaterOn  = true;
    dryingExhaustOn = false;

  } else if (serviceType == "sterilizing") {
    setRelay(8, true); // UVC
    setRelay(7, true); // Atomizer + Mist Fan
  }

  sendServiceStatusUpdate();
}

void stopService() {
  if (!serviceActive) return;
  serviceActive = false;

  rgbOff();

  if (currentServiceType == "cleaning") {
    setRelay(5, false);
    cleaningPhase = 0;
    brushCurrentCycle = 0;
    stepper1MoveTo(CLEANING_MAX_POSITION);
    stepper2MoveTo(0);
    motorsCoast();
    setServoPositions(0, true);

  } else if (currentServiceType == "drying") {
    setRelay(3, false);
    setRelay(4, false);
    setRelay(6, false);
    setRelay(2, false);
    dryingHeaterOn  = false;
    dryingExhaustOn = false;
    // Purge: exhaust ON for 15s to cool down chamber
    setRelay(2, true);
    purgeActive      = true;
    purgeStartTime   = millis();
    purgeServiceType = currentServiceType;
    purgeShoeType    = currentShoeType;
    purgeCareType    = currentCareType;

  } else if (currentServiceType == "sterilizing") {
    setRelay(7, false);
    setRelay(8, false);
    // Purge: exhaust ON for 15s to clear residual mist
    setRelay(2, true);
    purgeActive      = true;
    purgeStartTime   = millis();
    purgeServiceType = currentServiceType;
    purgeShoeType    = currentShoeType;
    purgeCareType    = currentCareType;
  }

  if (wsConnected && isPaired) {
    String msg = "{\"type\":\"service-complete\",\"deviceId\":\"" + deviceId +
                 "\",\"serviceType\":\"" + currentServiceType +
                 "\",\"shoeType\":\"" + currentShoeType +
                 "\",\"careType\":\"" + currentCareType + "\"}";
    webSocket.sendTXT(msg);
  }

  currentShoeType    = "";
  currentServiceType = "";
  currentCareType    = "";
}

void handlePurge() {
  if (!purgeActive) return;

  if (millis() - purgeStartTime >= PURGE_DURATION_MS) {
    purgeActive = false;
    setRelay(2, false);
    purgeServiceType = "";
    purgeShoeType    = "";
    purgeCareType    = "";
  }
}

void handleDryingTemperature() {
  if (!serviceActive || currentServiceType != "drying") return;
  if (currentTemperature <= 0.0) return;

  if (currentTemperature < DRYING_TEMP_LOW) {
    if (!dryingHeaterOn) {
      setRelay(4, true);
      setRelay(6, true);
      dryingHeaterOn = true;
    }
    if (dryingExhaustOn) {
      setRelay(2, false);
      dryingExhaustOn = false;
    }
  } else if (currentTemperature > DRYING_TEMP_HIGH) {
    if (dryingHeaterOn) {
      setRelay(4, false);
      setRelay(6, false);
      dryingHeaterOn = false;
    }
    if (!dryingExhaustOn) {
      setRelay(2, true);
      dryingExhaustOn = true;
    }
  }
  // Within 35–40°C band: hold current state (hysteresis)
}

void handleService() {
  if (!serviceActive) return;

  unsigned long elapsed = millis() - serviceStartTime;

  if (elapsed >= serviceDuration) {
    stopService();
    return;
  }

  // Cleaning phase state machine
  if (currentServiceType == "cleaning" && cleaningPhase > 0) {

    if (cleaningPhase == 1) {
      // Top linear moving to 480mm start position
      if (!stepper1Moving) {
        cleaningPhase = 2;
        stepper1MoveTo(0);
      }

    } else if (cleaningPhase == 2) {
      // Top linear moving 480 → 0
      if (!stepper1Moving) {
        cleaningPhase = 3;
        stepper1MoveTo(CLEANING_MAX_POSITION);
      }

    } else if (cleaningPhase == 3) {
      // Top linear returning 0 → 480, then start brushing
      if (!stepper1Moving) {
        cleaningPhase = 4;
        brushCurrentCycle = 1;
        brushPhaseStartTime = millis();
        setMotorsSameSpeed(BRUSH_MOTOR_SPEED);

        // Sweep servos 0° → 180° over remaining service time
        unsigned long remainingMs = (elapsed < serviceDuration)
                                    ? serviceDuration - elapsed : 1;
        int dynInterval = max(1, (int)((remainingMs / 15UL) / 180UL));
        setServoPositions(180, false);
        servoStepInterval = dynInterval;
      }

    } else if (cleaningPhase == 4) {
      // Brushing CW
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        motorsCoast();
        cleaningPhase = 6;
        brushNextPhase = 5;
        brushPhaseStartTime = millis();
      }

    } else if (cleaningPhase == 5) {
      // Brushing CCW
      if (millis() - brushPhaseStartTime >= BRUSH_DURATION_MS) {
        brushCurrentCycle++;
        if (brushCurrentCycle > BRUSH_TOTAL_CYCLES) {
          motorsCoast();
          cleaningPhase = 0;
          brushCurrentCycle = 0;
          stopService();
          return;
        } else {
          motorsCoast();
          cleaningPhase = 6;
          brushNextPhase = 4;
          brushPhaseStartTime = millis();
        }
      }

    } else if (cleaningPhase == 6) {
      // Coast transition between direction changes
      if (millis() - brushPhaseStartTime >= BRUSH_COAST_MS) {
        cleaningPhase = brushNextPhase;
        brushPhaseStartTime = millis();
        setMotorsSameSpeed(brushNextPhase == 5 ? -BRUSH_MOTOR_SPEED : BRUSH_MOTOR_SPEED);
      }
    }
  }

  if (millis() - lastServiceStatusUpdate >= SERVICE_STATUS_UPDATE_INTERVAL) {
    lastServiceStatusUpdate = millis();
    sendServiceStatusUpdate();
  }
}

void sendServiceStatusUpdate() {
  if (!wsConnected || !isPaired) return;

  unsigned long elapsed   = millis() - serviceStartTime;
  unsigned long remaining = (elapsed < serviceDuration)
                            ? (serviceDuration - elapsed) / 1000 : 0;
  int progress = (serviceDuration > 0) ? min((int)((elapsed * 100) / serviceDuration), 100) : 0;

  webSocket.sendTXT("{\"type\":\"service-status\",\"deviceId\":\"" + deviceId +
                    "\",\"serviceType\":\"" + currentServiceType +
                    "\",\"shoeType\":\"" + currentShoeType +
                    "\",\"careType\":\"" + currentCareType +
                    "\",\"active\":" + String(serviceActive ? "true" : "false") +
                    ",\"progress\":" + String(progress) +
                    ",\"timeRemaining\":" + String(remaining) + "}");
}
