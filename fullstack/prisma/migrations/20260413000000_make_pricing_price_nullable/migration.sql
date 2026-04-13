-- Make price nullable so NULL means "not configured — use hardware default"
ALTER TABLE "service_pricing" ALTER COLUMN "price" DROP NOT NULL;
