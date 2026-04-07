/**
 * ===================== MOTOR & ACTUATOR CONTROL =====================
 *
 * Controls all motion hardware:
 *   - 2× MG995 Servo motors (left/right shoe holder, 0–180° synchronized)
 *   - 2× DRV8871 DC brush motors (left/right cleaning brushes, ±255 PWM)
 *   - TB6600 Stepper 1 (top linear slide — foam dispenser, NEMA11)
 *   - TB6600 Stepper 2 (side linear slide — shoe conveyor, mini rail)
 *
 * Servo synchronization:
 *   Left and right servos move in opposition (L + R = 180°) to tilt the
 *   shoe holder. Movement is interpolated 1° per step for smooth motion.
 *
 * Stepper positioning:
 *   Positions are tracked in absolute steps and persisted to NVS.
 *   At boot, steppers return to their home positions if displaced.
 */

void updateServoPositions() {
  if (!servosMoving) return;

  if (millis() - lastServoUpdate < SERVO_UPDATE_INTERVAL) return;
  lastServoUpdate = millis();

  servoStepCounter++;
  if (servoStepCounter < servoStepInterval) return;
  servoStepCounter = 0;

  bool leftReached  = false;
  bool rightReached = false;

  if      (currentLeftPosition < targetLeftPosition)  { currentLeftPosition++;  servoLeft.write(currentLeftPosition); }
  else if (currentLeftPosition > targetLeftPosition)  { currentLeftPosition--;  servoLeft.write(currentLeftPosition); }
  else                                                 { leftReached = true; }

  if      (currentRightPosition < targetRightPosition) { currentRightPosition++; servoRight.write(currentRightPosition); }
  else if (currentRightPosition > targetRightPosition) { currentRightPosition--; servoRight.write(currentRightPosition); }
  else                                                  { rightReached = true; }

  if (leftReached && rightReached) {
    servosMoving = false;
    LOG("[Servo] Reached L:" + String(currentLeftPosition) + " R:" + String(currentRightPosition));
  }
}

void setServoPositions(int leftPos, bool fastMode) {
  leftPos = constrain(leftPos, 0, 180);
  int rightPos = 180 - leftPos;

  servoStepInterval = fastMode ? SERVO_FAST_STEP_INTERVAL : SERVO_SLOW_STEP_INTERVAL;
  servoStepCounter  = 0;

  if (leftPos != currentLeftPosition || rightPos != currentRightPosition) {
    targetLeftPosition  = leftPos;
    targetRightPosition = rightPos;
    servosMoving = true;
    LOG("[Servo] Moving to L:" + String(leftPos) + " R:" + String(rightPos));
  }
}

/* ===================== DC MOTORS (DRV8871) ===================== */

void setLeftMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentLeftMotorSpeed = speed;
  if      (speed > 0) { ledcWrite(MOTOR_LEFT_IN1_CH, speed);    ledcWrite(MOTOR_LEFT_IN2_CH, 0); }
  else if (speed < 0) { ledcWrite(MOTOR_LEFT_IN1_CH, 0);        ledcWrite(MOTOR_LEFT_IN2_CH, abs(speed)); }
  else                { ledcWrite(MOTOR_LEFT_IN1_CH, 0);        ledcWrite(MOTOR_LEFT_IN2_CH, 0); }
  LOG("[Motor] Left=" + String(speed));
}

void setRightMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentRightMotorSpeed = speed;
  if      (speed > 0) { ledcWrite(MOTOR_RIGHT_IN1_CH, speed);   ledcWrite(MOTOR_RIGHT_IN2_CH, 0); }
  else if (speed < 0) { ledcWrite(MOTOR_RIGHT_IN1_CH, 0);       ledcWrite(MOTOR_RIGHT_IN2_CH, abs(speed)); }
  else                { ledcWrite(MOTOR_RIGHT_IN1_CH, 0);       ledcWrite(MOTOR_RIGHT_IN2_CH, 0); }
  LOG("[Motor] Right=" + String(speed));
}

void setMotorsSameSpeed(int speed) {
  setLeftMotorSpeed(speed);
  setRightMotorSpeed(speed);
}

void leftMotorBrake()  { ledcWrite(MOTOR_LEFT_IN1_CH, 255);  ledcWrite(MOTOR_LEFT_IN2_CH, 255);  currentLeftMotorSpeed  = 0; }
void rightMotorBrake() { ledcWrite(MOTOR_RIGHT_IN1_CH, 255); ledcWrite(MOTOR_RIGHT_IN2_CH, 255); currentRightMotorSpeed = 0; }
void motorsBrake()     { leftMotorBrake(); rightMotorBrake(); }

void leftMotorCoast()  { ledcWrite(MOTOR_LEFT_IN1_CH, 0);    ledcWrite(MOTOR_LEFT_IN2_CH, 0);    currentLeftMotorSpeed  = 0; }
void rightMotorCoast() { ledcWrite(MOTOR_RIGHT_IN1_CH, 0);   ledcWrite(MOTOR_RIGHT_IN2_CH, 0);   currentRightMotorSpeed = 0; }
void motorsCoast()     { leftMotorCoast(); rightMotorCoast(); }

/* ===================== STEPPER 1 — TOP LINEAR (TB6600 / NEMA11) ===================== */

void setStepper1Speed(int stepsPerSecond) {
  stepper1Speed = constrain(stepsPerSecond, 1, STEPPER1_MAX_SPEED);
  stepper1StepInterval = 1000000UL / stepper1Speed;
}

void stepper1Step(bool direction) {
  digitalWrite(STEPPER1_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3);
  digitalWrite(STEPPER1_STEP_PIN, HIGH);
  delayMicroseconds(2);
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  currentStepper1Position += direction ? 1 : -1;
}

void stepper1MoveTo(long position) {
  targetStepper1Position = position;
  if (targetStepper1Position != currentStepper1Position) {
    stepper1Moving = true;
    LOG("[S1] Moving to " + String(targetStepper1Position));
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
  LOG("[S1] Stopped at " + String(currentStepper1Position));
}

void stepper1Home() {
  currentStepper1Position = 0;
  targetStepper1Position  = 0;
  stepper1Moving = false;
  prefs.putLong("s1pos", 0);
  LOG("[S1] Home set");
  wsLog("info", "S1 zeroed at current position (NVS saved)");
}

void updateStepper1Position() {
  if (!stepper1Moving) return;

  if (micros() - lastStepper1Update < stepper1StepInterval) return;
  lastStepper1Update = micros();

  if      (currentStepper1Position < targetStepper1Position) stepper1Step(true);
  else if (currentStepper1Position > targetStepper1Position) stepper1Step(false);
  else {
    stepper1Moving = false;
    prefs.putLong("s1pos", currentStepper1Position);
    LOG("[S1] Reached " + String(currentStepper1Position));
  }
}

/* ===================== STEPPER 2 — SIDE LINEAR (TB6600 / Mini Rail) ===================== */

void setStepper2Speed(int stepsPerSecond) {
  stepper2Speed = constrain(stepsPerSecond, 1, STEPPER2_MAX_SPEED);
  stepper2StepInterval = 1000000UL / stepper2Speed;
}

void stepper2Step(bool direction) {
  digitalWrite(STEPPER2_DIR_PIN, direction ? HIGH : LOW);
  delayMicroseconds(3);
  digitalWrite(STEPPER2_STEP_PIN, HIGH);
  delayMicroseconds(2);
  digitalWrite(STEPPER2_STEP_PIN, LOW);
  currentStepper2Position += direction ? 1 : -1;
}

void stepper2MoveTo(long position) {
  position = constrain(position, 0L, STEPPER2_MAX_POSITION);
  targetStepper2Position = position;
  if (targetStepper2Position != currentStepper2Position) {
    stepper2Moving = true;
    LOG("[S2] Moving to " + String(targetStepper2Position));
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
  LOG("[S2] Stopped at " + String(currentStepper2Position));
}

void stepper2Home() {
  currentStepper2Position = 0;
  targetStepper2Position  = 0;
  stepper2Moving = false;
  prefs.putLong("s2pos", 0);
  LOG("[S2] Home set");
  wsLog("info", "S2 zeroed at current position (NVS saved)");
}

void updateStepper2Position() {
  if (!stepper2Moving) return;

  if (micros() - lastStepper2Update < stepper2StepInterval) return;
  lastStepper2Update = micros();

  if      (currentStepper2Position < targetStepper2Position) stepper2Step(true);
  else if (currentStepper2Position > targetStepper2Position) stepper2Step(false);
  else {
    stepper2Moving = false;
    prefs.putLong("s2pos", currentStepper2Position);
    LOG("[S2] Reached " + String(currentStepper2Position));
  }
}
