/**
 * Motor Control (Servos, DC Motors, Steppers)
 * Unified handling for all mechanical actuators in the system.
 */

/* ===================== SERVO MOTORS ===================== */

// Smoothly update servo positions (call in loop)
void updateServoPositions() {
  if (!servosMoving)
    return;

  unsigned long currentTime = millis();
  if (currentTime - lastServoUpdate >= SERVO_UPDATE_INTERVAL) {
    lastServoUpdate = currentTime;

    // Throttle updates based on speed interval
    servoStepCounter++;
    if (servoStepCounter < servoStepInterval) {
      return;
    }
    servoStepCounter = 0;

    bool leftReached = (currentLeftPosition == targetLeftPosition);
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

// Set target positions for both servos
void setServoPositions(int leftPos, bool fastMode) {
  // Constrain inputs to physical limits
  leftPos = constrain(leftPos, 0, 180);
  int rightPos = 180 - leftPos; // Mirror the right servo

  // Set speed
  servoStepInterval =
      fastMode ? SERVO_FAST_STEP_INTERVAL : SERVO_SLOW_STEP_INTERVAL;
  servoStepCounter = 0;

  if (leftPos != currentLeftPosition || rightPos != currentRightPosition) {
    targetLeftPosition = leftPos;
    targetRightPosition = rightPos;
    servosMoving = true;
  }
}

/* ===================== DRV8871 DC MOTORS ===================== */

void setLeftMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentLeftMotorSpeed = speed;

  if (speed > 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, speed);
    ledcWrite(MOTOR_LEFT_IN2_PIN, 0);
  } else if (speed < 0) {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
    ledcWrite(MOTOR_LEFT_IN2_PIN, abs(speed));
  } else {
    ledcWrite(MOTOR_LEFT_IN1_PIN, 0);
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

/* ===================== TB6600 STEPPER 1 (TOP) ===================== */

void setStepper1Speed(int stepsPerSecond) {
  stepper1Speed = constrain(stepsPerSecond, 1, STEPPER1_MAX_SPEED);
  stepper1StepInterval = 1000000UL / stepper1Speed;
}

void stepper1Step(bool direction) {
  digitalWrite(STEPPER1_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3);
  digitalWrite(STEPPER1_STEP_PIN, HIGH);
  delayMicroseconds(STEPPER1_MIN_PULSE_WIDTH);
  digitalWrite(STEPPER1_STEP_PIN, LOW);

  if (direction) {
    currentStepper1Position++;
  } else {
    currentStepper1Position--;
  }
}

void stepper1MoveTo(long position) {
  targetStepper1Position = position;
  if (targetStepper1Position != currentStepper1Position) {
    stepper1Moving = true;
  }
}

void stepper1MoveRelative(long steps) {
  stepper1MoveTo(currentStepper1Position + steps);
}

void stepper1MoveByMM(float mm) {
  stepper1MoveRelative((long)(mm * STEPPER1_STEPS_PER_MM));
}

void stepper1Stop() {
  targetStepper1Position = currentStepper1Position;
  stepper1Moving = false;
}

void stepper1Home() {
  currentStepper1Position = 0;
  targetStepper1Position = 0;
  stepper1Moving = false;
  prefs.putLong("s1pos", 0);
}

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
      prefs.putLong("s1pos", currentStepper1Position);
    }
  }
}

/* ===================== TB6600 STEPPER 2 (SIDE) ===================== */

void setStepper2Speed(int stepsPerSecond) {
  stepper2Speed = constrain(stepsPerSecond, 1, STEPPER2_MAX_SPEED);
  stepper2StepInterval = 1000000UL / stepper2Speed;
}

void stepper2Step(bool direction) {
  digitalWrite(STEPPER2_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3);
  digitalWrite(STEPPER2_STEP_PIN, HIGH);
  delayMicroseconds(STEPPER2_MIN_PULSE_WIDTH);
  digitalWrite(STEPPER2_STEP_PIN, LOW);

  if (direction) {
    currentStepper2Position++;
  } else {
    currentStepper2Position--;
  }
}

void stepper2MoveTo(long position) {
  // Constrain target position to physical rail limit (100mm = 20k steps)
  position = constrain(position, 0, STEPPER2_MAX_POSITION);

  targetStepper2Position = position;
  if (targetStepper2Position != currentStepper2Position) {
    stepper2Moving = true;
  }
}

void stepper2MoveRelative(long steps) {
  stepper2MoveTo(currentStepper2Position + steps);
}

void stepper2MoveByMM(float mm) {
  stepper2MoveRelative((long)(mm * STEPPER2_STEPS_PER_MM));
}

void stepper2Stop() {
  targetStepper2Position = currentStepper2Position;
  stepper2Moving = false;
}

void stepper2Home() {
  currentStepper2Position = 0;
  targetStepper2Position = 0;
  stepper2Moving = false;
  prefs.putLong("s2pos", 0);
}

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
      prefs.putLong("s2pos", currentStepper2Position);
    }
  }
}
