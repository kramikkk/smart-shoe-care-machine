import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = global as unknown as {
  prisma: ReturnType<typeof createPrismaClient>;
};

function createPrismaClient() {
  const dbUrl = new URL(process.env.DATABASE_URL!);
  dbUrl.searchParams.set('sslmode', 'verify-full');
  const pool = new Pool({
    connectionString: dbUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: 2,                    // keep footprint small on memory-constrained hosts
    idleTimeoutMillis: 30_000, // release idle connections after 30s
    connectionTimeoutMillis: 5_000,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Always cache on global so module re-evaluation (Next.js HMR in dev, worker restarts
// in prod) reuses the existing client instead of opening a new connection.
globalForPrisma.prisma = prisma;

export default prisma;
