/**
 * Motor Control (Servos, DC Motors, Steppers)
 * Unified handling for all mechanical actuators in the system.
 *
 * Actuator overview:
 *   Servos   — Two servos (left/right) mounted as a mirrored pair for the shoe-entry gate.
 *              Driven by the Servo library; positions interpolated 1°/tick in loop().
 *   DC motors — Two DRV8871 H-bridge drivers (left/right brush motors).
 *              PWM via ledcWrite on IN1/IN2; 1kHz frequency, 8-bit (0–255) resolution.
 *              Speed direction: positive → IN1 driven; negative → IN2 driven.
 *              Brake: both IN HIGH (active short). Coast: both IN LOW (float).
 *   Steppers  — Two TB6600 stepper drivers (STEP/DIR pulse interface).
 *              Stepper 1 (top brush, vertical): 2mm/rev lead screw → 10 steps/mm,
 *                travel 0–4800 steps (48mm), pulse timing via micros().
 *              Stepper 2 (side brush, horizontal): 1mm/rev lead screw → 200 steps/mm,
 *                travel 0–20000 steps (100mm), constrained in stepper2MoveTo().
 */

/* ===================== SERVO MOTORS ===================== */

/**
 * Advance both servos one step toward their targets if the step timer has elapsed.
 * Called every loop() iteration; non-blocking — returns immediately if nothing to do.
 *
 * Speed control uses a two-tier timer:
 *   - SERVO_UPDATE_INTERVAL (1ms): outer tick that ensures we check at most once per ms.
 *   - servoStepInterval: inner divider counted by servoStepCounter.
 *     SERVO_SLOW_STEP_INTERVAL = 105 → one degree every 105ms ≈ 1.575s for 180° sweep.
 *     SERVO_FAST_STEP_INTERVAL = 1  → one degree every 1ms ≈ 180ms for full sweep.
 *
 * Both servos move simultaneously; servosMoving is cleared when both reach their targets.
 */
void updateServoPositions() {
  if (!servosMoving)
    return;

  unsigned long currentTime = millis();
  if (currentTime - lastServoUpdate >= SERVO_UPDATE_INTERVAL) {
    lastServoUpdate = currentTime;

    // servoStepCounter counts outer ticks; only advance position on the Nth tick.
    servoStepCounter++;
    if (servoStepCounter < servoStepInterval) {
      return;
    }
    servoStepCounter = 0;

    bool leftReached  = (currentLeftPosition  == targetLeftPosition);
    bool rightReached = (currentRightPosition == targetRightPosition);

    if (!leftReached) {
      if (currentLeftPosition < targetLeftPosition) {
        currentLeftPosition++;
      } else {
        currentLeftPosition--;
      }
      servoLeft.write(currentLeftPosition);
    }

    if (!rightReached) {
      if (currentRightPosition < targetRightPosition) {
        currentRightPosition++;
      } else {
        currentRightPosition--;
      }
      servoRight.write(currentRightPosition);
    }

    if (leftReached && rightReached) {
      servosMoving = false;
    }
  }
}

/**
 * Set the target angle for the servo pair and choose movement speed.
 * leftPos (0–180°) is constrained to physical limits; rightPos mirrors it (180 - leftPos)
 * so both arms open/close symmetrically around the shoe-entry channel.
 * fastMode selects SERVO_FAST_STEP_INTERVAL; slow mode is used for the scanning sweep.
 */
void setServoPositions(int leftPos, bool fastMode) {
  leftPos = constrain(leftPos, 0, 180);
  int rightPos = 180 - leftPos; // Right servo is mechanically mirrored

  servoStepInterval = fastMode ? SERVO_FAST_STEP_INTERVAL : SERVO_SLOW_STEP_INTERVAL;
  servoStepCounter = 0; // Reset divider so movement starts on the very next tick

  if (leftPos != currentLeftPosition || rightPos != currentRightPosition) {
    targetLeftPosition  = leftPos;
    targetRightPosition = rightPos;
    servosMoving = true;
  }
}

/* ===================== DRV8871 DC MOTORS ===================== */

/**
 * DRV8871 H-bridge truth table (PWM on each input pin):
 *   IN1 > 0, IN2 = 0  → forward (CW)
 *   IN1 = 0, IN2 > 0  → reverse (CCW)
 *   IN1 = 0, IN2 = 0  → coast (outputs floating)
 *   IN1 = 255, IN2 = 255 → brake (outputs shorted to GND via H-bridge)
 *
 * speed: -255 to +255. Negative values drive IN2 (reverse direction).
 * PWM channel frequency is 1kHz (set in setup()) — above audible range.
 */
void setLeftMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentLeftMotorSpeed = speed;

  if (speed > 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, speed); // Forward: IN1 driven, IN2 off
    ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  } else if (speed < 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
    ledcWrite(MOTOR_LEFT_IN2_PIN, abs(speed)); // Reverse: IN2 driven, IN1 off
  } else {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0); // Speed == 0: coast (both off)
    ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  }
}

void setRightMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentRightMotorSpeed = speed;

  if (speed > 0) {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, speed);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  } else if (speed < 0) {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, abs(speed));
  } else {
    ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
    ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  }
}

void setMotorsSameSpeed(int speed) {
  setLeftMotorSpeed(speed);
  setRightMotorSpeed(speed);
}

/**
 * Active brake: drive both IN1 and IN2 HIGH simultaneously.
 * DRV8871 responds by shorting both motor terminals to GND through the H-bridge,
 * creating a regenerative braking effect that quickly stops the brush.
 */
void leftMotorBrake() {
  ledcWrite(MOTOR_LEFT_IN1_PIN, 255);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 255);
  currentLeftMotorSpeed = 0;
}

void rightMotorBrake() {
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 255);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 255);
  currentRightMotorSpeed = 0;
}

void motorsBrake() {
  leftMotorBrake();
  rightMotorBrake();
}

/**
 * Coast: drive both IN1 and IN2 LOW.
 * DRV8871 lets the motor spin freely (no braking force).
 * Used between CW/CCW brush cycles to let the brush decelerate naturally
 * before reversing direction, reducing mechanical stress.
 */
void leftMotorCoast() {
  ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
  ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  currentLeftMotorSpeed = 0;
}

void rightMotorCoast() {
  ledcWrite(MOTOR_RIGHT_IN1_PIN, 0);
  ledcWrite(MOTOR_RIGHT_IN2_PIN, 0);
  currentRightMotorSpeed = 0;
}

void motorsCoast() {
  leftMotorCoast();
  rightMotorCoast();
}

/* ===================== TB6600 STEPPER 1 (TOP BRUSH — VERTICAL AXIS) ===================== */

/**
 * Set Stepper 1 pulse rate.
 * stepper1StepInterval (µs) = 1,000,000 / stepsPerSecond
 * e.g. 500 sps → 2000 µs between pulses.
 * Constrained to [1, STEPPER1_MAX_SPEED] to prevent division by zero or over-driving the driver.
 */
void setStepper1Speed(int stepsPerSecond) {
  stepper1Speed = constrain(stepsPerSecond, 1, STEPPER1_MAX_SPEED);
  stepper1StepInterval = 1000000UL / stepper1Speed;
}

/**
 * Fire one STEP pulse on Stepper 1 and update the position counter.
 * TB6600 requirements:
 *   - DIR must be stable ≥ 3µs before the rising edge of STEP.
 *   - STEP pulse width ≥ STEPPER1_MIN_PULSE_WIDTH µs (typically 5µs).
 * direction: true = forward (increase position), false = reverse (decrease position).
 */
void stepper1Step(bool direction) {
  digitalWrite(STEPPER1_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3); // DIR setup time before STEP rising edge
  digitalWrite(STEPPER1_STEP_PIN, HIGH);
  delayMicroseconds(STEPPER1_MIN_PULSE_WIDTH); // Hold STEP HIGH for minimum pulse width
  digitalWrite(STEPPER1_STEP_PIN, LOW);

  if (direction) {
    currentStepper1Position++;
  } else {
    currentStepper1Position--;
  }
}

/** Queue an absolute move to `position` steps. Movement is executed in updateStepper1Position(). */
void stepper1MoveTo(long position) {
  targetStepper1Position = position;
  if (targetStepper1Position != currentStepper1Position) {
    stepper1Moving = true;
  }
}

/** Queue a move relative to the current position (positive = forward, negative = backward). */
void stepper1MoveRelative(long steps) {
  stepper1MoveTo(currentStepper1Position + steps);
}

/** Move by a physical distance in millimetres (×STEPPER1_STEPS_PER_MM = 10 steps/mm). */
void stepper1MoveByMM(float mm) {
  stepper1MoveRelative((long)(mm * STEPPER1_STEPS_PER_MM));
}

/** Immediately halt Stepper 1 at its current position (no deceleration ramp). */
void stepper1Stop() {
  targetStepper1Position = currentStepper1Position;
  stepper1Moving = false;
}

/**
 * Declare the current physical position as the zero reference point.
 * Resets both current and target counters and persists zero to NVS so the
 * position survives a power cycle (stepper has no physical home switch).
 */
void stepper1Home() {
  currentStepper1Position = 0;
  targetStepper1Position  = 0;
  stepper1Moving = false;
  prefs.putLong("s1pos", 0);
}

/**
 * Non-blocking step executor — called every loop() iteration.
 * Uses micros() for µs-resolution timing so the step rate is accurate
 * regardless of how long the rest of loop() takes between calls.
 * Position is persisted to NVS when the move completes.
 */
void updateStepper1Position() {
  if (!stepper1Moving)
    return;

  unsigned long currentMicros = micros();
  if (currentMicros - lastStepper1Update >= stepper1StepInterval) {
    lastStepper1Update = currentMicros;

    if (currentStepper1Position < targetStepper1Position) {
      stepper1Step(true);
    } else if (currentStepper1Position > targetStepper1Position) {
      stepper1Step(false);
    } else {
      stepper1Moving = false;
      prefs.putLong("s1pos", currentStepper1Position); // Persist final position to NVS
    }
  }
}

/* ===================== TB6600 STEPPER 2 (SIDE BRUSH — HORIZONTAL AXIS) ===================== */

/** Set Stepper 2 pulse rate. Same formula as Stepper 1: interval_µs = 1,000,000 / sps. */
void setStepper2Speed(int stepsPerSecond) {
  stepper2Speed = constrain(stepsPerSecond, 1, STEPPER2_MAX_SPEED);
  stepper2StepInterval = 1000000UL / stepper2Speed;
}

/**
 * Fire one STEP pulse on Stepper 2.
 * Same TB6600 DIR setup time (3µs) and minimum STEP pulse width requirements as Stepper 1.
 */
void stepper2Step(bool direction) {
  digitalWrite(STEPPER2_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3); // DIR setup time before STEP rising edge
  digitalWrite(STEPPER2_STEP_PIN, HIGH);
  delayMicroseconds(STEPPER2_MIN_PULSE_WIDTH);
  digitalWrite(STEPPER2_STEP_PIN, LOW);

  if (direction) {
    currentStepper2Position++;
  } else {
    currentStepper2Position--;
  }
}

/**
 * Queue an absolute move for Stepper 2.
 * Target is constrained to [0, STEPPER2_MAX_POSITION] (0–20000 steps = 0–100mm)
 * to prevent the side brush from over-travelling the physical rail end stop.
 */
void stepper2MoveTo(long position) {
  position = constrain(position, 0, STEPPER2_MAX_POSITION); // Hard limit: 100mm rail
  targetStepper2Position = position;
  if (targetStepper2Position != currentStepper2Position) {
    stepper2Moving = true;
  }
}

/** Queue a relative move for Stepper 2. constrain in stepper2MoveTo() prevents over-travel. */
void stepper2MoveRelative(long steps) {
  stepper2MoveTo(currentStepper2Position + steps);
}

/** Move Stepper 2 by a physical distance in mm (×STEPPER2_STEPS_PER_MM = 200 steps/mm). */
void stepper2MoveByMM(float mm) {
  stepper2MoveRelative((long)(mm * STEPPER2_STEPS_PER_MM));
}

/** Immediately halt Stepper 2 at its current position. */
void stepper2Stop() {
  targetStepper2Position = currentStepper2Position;
  stepper2Moving = false;
}

/**
 * Declare the current physical position as the Stepper 2 zero reference (retracted/home).
 * Persists to NVS so the position survives restarts (no home switch fitted).
 */
void stepper2Home() {
  currentStepper2Position = 0;
  targetStepper2Position  = 0;
  stepper2Moving = false;
  prefs.putLong("s2pos", 0);
}

/**
 * Non-blocking step executor for Stepper 2 — called every loop() iteration.
 * micros()-based timing provides µs-resolution step rate accuracy.
 * Position is persisted to NVS when the move completes.
 */
void updateStepper2Position() {
  if (!stepper2Moving)
    return;

  unsigned long currentMicros = micros();
  if (currentMicros - lastStepper2Update >= stepper2StepInterval) {
    lastStepper2Update = currentMicros;

    if (currentStepper2Position < targetStepper2Position) {
      stepper2Step(true);
    } else if (currentStepper2Position > targetStepper2Position) {
      stepper2Step(false);
    } else {
      stepper2Moving = false;
      prefs.putLong("s2pos", currentStepper2Position); // Persist final position to NVS
    }
  }
}
