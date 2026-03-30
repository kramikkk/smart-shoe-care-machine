-- CreateTable
CREATE TABLE "device_alert" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "device_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_alert_deviceId_resolvedAt_idx" ON "device_alert"("deviceId", "resolvedAt");

-- CreateIndex
CREATE INDEX "device_alert_deviceId_alertKey_resolvedAt_idx" ON "device_alert"("deviceId", "alertKey", "resolvedAt");

-- AddForeignKey
ALTER TABLE "device_alert" ADD CONSTRAINT "device_alert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
