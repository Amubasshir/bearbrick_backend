#!/usr/bin/env node
/**
 * Full flow test: verifies Spec logic (vote → enrich → aggregate → state).
 * Requires: server NOT needed; DB seeded; run from project root.
 * Usage: node scripts/test-full-flow.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { execSync } = require("child_process");

async function run() {
  console.log(
    "=== Full flow test (SPECIFICATION / CLARIFICATIONS logic) ===\n",
  );

  const brick = await prisma.brickPriceState.findFirst();
  if (!brick) {
    console.log("No bricks. Run: npm run db:seed");
    process.exit(1);
  }
  const user = await prisma.user.findFirst({
    where: { email: "admin@example.com" },
  });
  if (!user) {
    console.log("No user admin@example.com. Run: npm run db:seed");
    process.exit(1);
  }

  const brickId = brick.brickId;
  const liveBefore = Number(brick.livePrice);

  console.log("1. Create vote intent (API write only)");
  const intent = await prisma.voteIntent.create({
    data: {
      userId: user.id,
      brickId,
      voteType: "OVER",
      status: "PENDING",
      ipHash: require("crypto")
        .createHash("sha256")
        .update("127.0.0.1")
        .digest("hex"),
      userAgent: "test-full-flow",
    },
  });
  console.log("   Created intent id:", intent.id);

  console.log("2. Run vote enricher (intents → events)");
  execSync("node src/scripts/enrich-votes.js", {
    stdio: "inherit",
    cwd: require("path").resolve(__dirname, ".."),
  });

  const eventCount = await prisma.voteEvent.count({ where: { brickId } });
  const intentAfter = await prisma.voteIntent.findUnique({
    where: { id: intent.id },
  });
  if (intentAfter.status !== "PROCESSED") {
    console.log(
      "   FAIL: intent status is",
      intentAfter.status,
      "(expected PROCESSED)",
    );
    process.exit(1);
  }
  console.log("   Vote events for brick:", eventCount);

  console.log("3. Run price aggregator (events → state)");
  execSync("node src/scripts/aggregate-prices.js", {
    stdio: "inherit",
    cwd: require("path").resolve(__dirname, ".."),
  });

  const stateAfter = await prisma.brickPriceState.findUnique({
    where: { brickId },
  });
  const liveAfter = Number(stateAfter.livePrice);
  console.log("4. Brick state after aggregate");
  console.log("   live_price before:", liveBefore, "→ after:", liveAfter);
  console.log(
    "   weighted_total:",
    stateAfter.weightedTotal,
    "| weighted_since_last_move:",
    stateAfter.weightedSinceLastMove,
  );
  console.log(
    "   p_under:",
    stateAfter.pUnder,
    "| p_fair:",
    stateAfter.pFair,
    "| p_over:",
    stateAfter.pOver,
  );
  console.log(
    "   pricing_confidence_c:",
    stateAfter.pricingConfidenceC,
    "| momentum_score:",
    stateAfter.momentumScore,
  );

  const xpCount = await prisma.xpEvent.count({
    where: { userId: user.id, brickId },
  });
  console.log("   XP events for user+brick:", xpCount);

  console.log("\n=== Full flow OK ===\n");
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
