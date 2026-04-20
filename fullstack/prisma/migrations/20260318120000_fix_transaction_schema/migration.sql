-- Drop status column (transactions are now immutable success records)
ALTER TABLE "transaction" DROP COLUMN IF EXISTS "status";

-- Drop transactionId column (was SERIAL in DB, String in schema — drift fixed by removal)
ALTER TABLE "transaction" DROP COLUMN IF EXISTS "transactionId";

-- Drop status index if it exists
DROP INDEX IF EXISTS "transaction_status_idx";

-- Add FK constraints for ServicePricing and ServiceDuration (were missing from DB)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'service_pricing'
      AND column_name = 'deviceId'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_pricing_deviceId_fkey'
  ) THEN
    ALTER TABLE "service_pricing"
      ADD CONSTRAINT "service_pricing_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "device"("deviceId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'service_duration'
      AND column_name = 'deviceId'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_duration_deviceId_fkey'
  ) THEN
    ALTER TABLE "service_duration"
      ADD CONSTRAINT "service_duration_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "device"("deviceId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
