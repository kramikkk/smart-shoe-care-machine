-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('ACTIVE', 'COMPLETED', 'INTERRUPTED', 'ABANDONED');

-- Add status column: convert existing text column if present, otherwise add fresh.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transaction' AND column_name = 'status'
  ) THEN
    ALTER TABLE "transaction"
      ALTER COLUMN "status" TYPE "transaction_status"
        USING "status"::"transaction_status";
  ELSE
    ALTER TABLE "transaction"
      ADD COLUMN "status" "transaction_status" NOT NULL DEFAULT 'COMPLETED';
  END IF;
END $$;

-- Add interruptedAt if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transaction' AND column_name = 'interruptedAt'
  ) THEN
    ALTER TABLE "transaction" ADD COLUMN "interruptedAt" TIMESTAMP(3);
  END IF;
END $$;

-- Add serviceCheckpoint if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transaction' AND column_name = 'serviceCheckpoint'
  ) THEN
    ALTER TABLE "transaction" ADD COLUMN "serviceCheckpoint" JSONB;
  END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "transaction_status_idx" ON "transaction"("status");
