#!/usr/bin/env node
/**
 * Tinker-like DB inspection (Laravel tinker equivalent).
 * Usage:
 *   node scripts/inspect-db.js           → full stats + first brick state
 *   node scripts/inspect-db.js brick-id  → print first brick_id
 *   node scripts/inspect-db.js stats     → counts (intents, events, xp, cursors)
 *   node scripts/inspect-db.js state     → all brick_price_state
 *   node scripts/inspect-db.js intents   → last 10 vote_intents
 *   node scripts/inspect-db.js events    → last 10 vote_events
 *   node scripts/inspect-db.js credits   → user_brick_vote_credits
 *   node scripts/inspect-db.js cursors   → worker_cursors
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const cmd = process.argv[2] || "";

async function brickId() {
  const s = await prisma.brickPriceState.findFirst();
  if (!s) {
    console.log("No bricks. Run: npm run db:seed");
    return;
  }
  console.log(s.brickId);
}

async function stats() {
  const [pending, processed, rejected, events, xp, bricks] = await Promise.all([
    prisma.voteIntent.count({ where: { status: "PENDING" } }),
    prisma.voteIntent.count({ where: { status: "PROCESSED" } }),
    prisma.voteIntent.count({ where: { status: "REJECTED" } }),
    prisma.voteEvent.count(),
    prisma.xpEvent.count(),
    prisma.brickPriceState.count(),
  ]);
  console.log("=== STATS ===");
  console.log(
    "Vote Intents:",
    pending + processed + rejected,
    "(Pending:",
    pending + ", Processed:",
    processed + ", Rejected:",
    rejected + ")",
  );
  console.log("Vote Events:", events);
  console.log("XP Events:", xp);
  console.log("Bricks:", bricks);
  const cursors = await prisma.workerCursor.findMany();
  console.log(
    "Worker Cursors:",
    cursors.map((c) => `${c.workerName}=${c.lastProcessedId}`).join(", "),
  );
}

async function state() {
  const states = await prisma.brickPriceState.findMany();
  console.log("=== BRICK PRICE STATE ===");
  for (const s of states) {
    console.log("Brick:", s.brickId);
    console.log(
      "  live_price:",
      Number(s.livePrice),
      "| weighted_total:",
      s.weightedTotal,
      "| weighted_since_last_move:",
      s.weightedSinceLastMove,
    );
    console.log(
      "  p_under:",
      s.pUnder,
      "| p_fair:",
      s.pFair,
      "| p_over:",
      s.pOver,
    );
    console.log(
      "  pricing_confidence_c:",
      s.pricingConfidenceC,
      "| momentum_score:",
      s.momentumScore,
    );
    console.log(
      "  freeze_mode:",
      s.freezeMode,
      "| needs_recheck:",
      s.needsRecheck,
    );
    console.log("  current_cycle_id:", s.currentCycleId);
  }
}

async function intents() {
  const list = await prisma.voteIntent.findMany({
    orderBy: { id: "desc" },
    take: 10,
    select: {
      id: true,
      userId: true,
      brickId: true,
      voteType: true,
      status: true,
      createdAt: true,
    },
  });
  console.log("=== LAST 10 VOTE INTENTS ===");
  list.forEach((i) =>
    console.log(
      "id:",
      i.id,
      "| user:",
      i.userId,
      "| brick:",
      i.brickId,
      "| vote:",
      i.voteType,
      "| status:",
      i.status,
    ),
  );
}

async function events() {
  const list = await prisma.voteEvent.findMany({
    orderBy: { id: "desc" },
    take: 10,
    select: {
      id: true,
      userId: true,
      brickId: true,
      voteType: true,
      userWeightAtVote: true,
      cycleId: true,
      createdAt: true,
    },
  });
  console.log("=== LAST 10 VOTE EVENTS ===");
  list.forEach((e) =>
    console.log(
      "id:",
      e.id,
      "| user:",
      e.userId,
      "| brick:",
      e.brickId,
      "| vote:",
      e.voteType,
      "| weight:",
      e.userWeightAtVote,
    ),
  );
}

async function credits() {
  const list = await prisma.userBrickVoteCredit.findMany();
  console.log("=== USER BRICK CREDITS ===");
  list.forEach((c) =>
    console.log(
      "user:",
      c.userId,
      "| brick:",
      c.brickId,
      "| credits_remaining:",
      c.creditsRemaining,
    ),
  );
}

async function cursors() {
  const list = await prisma.workerCursor.findMany();
  console.log("=== WORKER CURSORS ===");
  list.forEach((c) =>
    console.log(c.workerName, "→ last_processed_id:", c.lastProcessedId),
  );
}

async function full() {
  await stats();
  console.log("");
  const s = await prisma.brickPriceState.findFirst();
  if (s) {
    console.log("=== FIRST BRICK STATE ===");
    console.log("brick_id:", s.brickId);
    console.log(
      "live_price:",
      Number(s.livePrice),
      "| weighted_total:",
      s.weightedTotal,
    );
    console.log(
      "p_under:",
      s.pUnder,
      "| p_fair:",
      s.pFair,
      "| p_over:",
      s.pOver,
    );
  }
}

async function main() {
  try {
    if (cmd === "brick-id" || cmd === "brick_id") await brickId();
    else if (cmd === "stats") await stats();
    else if (cmd === "state") await state();
    else if (cmd === "intents") await intents();
    else if (cmd === "events") await events();
    else if (cmd === "credits") await credits();
    else if (cmd === "cursors") await cursors();
    else await full();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
