/* ===================== SERVO MOTORS ===================== */

// Non-blocking servo update — call every loop iteration.
// Left servo: 0°→180°, Right servo: 180°→0° (mirrored).
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

  if (leftReached && rightReached) servosMoving = false;
}

// Set servo target positions. Right servo mirrors left automatically.
// fastMode=true for quick return; false for slow brushing sweep.
void setServoPositions(int leftPos, bool fastMode) {
  leftPos = constrain(leftPos, 0, 180);
  int rightPos = 180 - leftPos;

  servoStepInterval = fastMode ? SERVO_FAST_STEP_INTERVAL : SERVO_SLOW_STEP_INTERVAL;
  servoStepCounter  = 0;

  if (leftPos != currentLeftPosition || rightPos != currentRightPosition) {
    targetLeftPosition  = leftPos;
    targetRightPosition = rightPos;
    servosMoving = true;
  }
}

/* ===================== DC MOTORS (DRV8871) ===================== */

void setLeftMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentLeftMotorSpeed = speed;
  if      (speed > 0) { ledcWrite(MOTOR_LEFT_IN1_CH, speed);    ledcWrite(MOTOR_LEFT_IN2_CH, 0); }
  else if (speed < 0) { ledcWrite(MOTOR_LEFT_IN1_CH, 0);        ledcWrite(MOTOR_LEFT_IN2_CH, abs(speed)); }
  else                { ledcWrite(MOTOR_LEFT_IN1_CH, 0);        ledcWrite(MOTOR_LEFT_IN2_CH, 0); }
}

void setRightMotorSpeed(int speed) {
  speed = constrain(speed, -255, 255);
  currentRightMotorSpeed = speed;
  if      (speed > 0) { ledcWrite(MOTOR_RIGHT_IN1_CH, speed);   ledcWrite(MOTOR_RIGHT_IN2_CH, 0); }
  else if (speed < 0) { ledcWrite(MOTOR_RIGHT_IN1_CH, 0);       ledcWrite(MOTOR_RIGHT_IN2_CH, abs(speed)); }
  else                { ledcWrite(MOTOR_RIGHT_IN1_CH, 0);       ledcWrite(MOTOR_RIGHT_IN2_CH, 0); }
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
  delayMicroseconds(3); // TB6600 direction setup time (min 2.5µs)
  digitalWrite(STEPPER1_STEP_PIN, HIGH);
  delayMicroseconds(2); // TB6600 pulse width (min 2µs)
  digitalWrite(STEPPER1_STEP_PIN, LOW);
  currentStepper1Position += direction ? 1 : -1;
}

void stepper1MoveTo(long position) {
  targetStepper1Position = position;
  if (targetStepper1Position != currentStepper1Position) stepper1Moving = true;
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
  targetStepper1Position  = 0;
  stepper1Moving = false;
  prefs.putLong("s1pos", 0);
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
  if (targetStepper2Position != currentStepper2Position) stepper2Moving = true;
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
  targetStepper2Position  = 0;
  stepper2Moving = false;
  prefs.putLong("s2pos", 0);
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
  }
}
