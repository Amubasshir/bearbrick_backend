#!/usr/bin/env node
/**
 * Debug script to check why weighted_total is not accumulating
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BRICK_ID = "11111111-1111-4111-8111-111111111101";

async function main() {
  const state = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });

  console.log("Current state:");
  console.log("  weightedTotal:", Number(state.weightedTotal));
  console.log("  weightedUnder:", Number(state.weightedUnder));
  console.log("  weightedFair:", Number(state.weightedFair));
  console.log("  weightedOver:", Number(state.weightedOver));
  console.log("  cycleId:", state.currentCycleId.substring(0, 16) + "...");
  console.log("  freezeMode:", state.freezeMode);

  const events = await prisma.voteEvent.findMany({
    where: {
      brickId: BRICK_ID,
      cycleId: state.currentCycleId,
    },
    orderBy: { id: "asc" },
    take: 10,
  });

  console.log("\nFirst 10 events in cycle:");
  events.forEach((e, i) => {
    console.log(
      `  ${i + 1}. ID:${Number(e.id)} Type:${e.voteType} Weight:${Number(
        e.userWeightAtVote
      )}`
    );
  });

  const sumWeights = events.reduce(
    (sum, e) => sum + Number(e.userWeightAtVote),
    0
  );
  console.log("\nSum of first 10 event weights:", sumWeights);
  console.log("Expected weightedTotal (if all processed):", sumWeights);
  console.log("Actual weightedTotal:", Number(state.weightedTotal));
  console.log(
    "Match:",
    Math.abs(sumWeights - Number(state.weightedTotal)) < 0.01
      ? "✅ YES"
      : "❌ NO"
  );

  await prisma.$disconnect();
}

main().catch(console.error);
