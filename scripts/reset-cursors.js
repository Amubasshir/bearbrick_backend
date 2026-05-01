#!/usr/bin/env node
/**
 * Reset worker cursors (for re-processing / testing).
 * Usage: node scripts/reset-cursors.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  await prisma.workerCursor.upsert({
    where: { workerName: "vote_enricher" },
    update: { lastProcessedId: 0 },
    create: { workerName: "vote_enricher", lastProcessedId: 0 },
  });
  await prisma.workerCursor.upsert({
    where: { workerName: "price_aggregator" },
    update: { lastProcessedId: 0 },
    create: { workerName: "price_aggregator", lastProcessedId: 0 },
  });
  console.log("Worker cursors reset to 0.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
