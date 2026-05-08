-- CreateEnum (idempotent — re-run safe if enum was partially created before)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
    CREATE TYPE "transaction_status" AS ENUM ('ACTIVE', 'COMPLETED', 'INTERRUPTED', 'ABANDONED');
  END IF;
END $$;

-- Add status column.
-- If the column exists as text (has a text default): drop the default first, cast to enum, re-add default.
-- If the column doesn't exist yet: add it fresh with the enum type and default.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transaction' AND column_name = 'status' AND data_type = 'text'
  ) THEN
    ALTER TABLE "transaction" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "transaction"
      ALTER COLUMN "status" TYPE "transaction_status"
        USING "status"::"transaction_status";
    ALTER TABLE "transaction"
      ALTER COLUMN "status" SET DEFAULT 'COMPLETED'::"transaction_status";
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transaction' AND column_name = 'status'
  ) THEN
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
