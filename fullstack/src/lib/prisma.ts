import { PrismaClient } from "@/generated/prisma";
import { withAccelerate } from "@prisma/extension-accelerate";

const globalForPrisma = global as unknown as {
  prisma: ReturnType<typeof createPrismaClient>;
};

function createPrismaClient() {
  return new PrismaClient().$extends(withAccelerate());
}

const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Always cache on global so module re-evaluation (Next.js HMR in dev, worker restarts
// in prod) reuses the existing client instead of opening a new connection.
globalForPrisma.prisma = prisma;

export default prisma;
