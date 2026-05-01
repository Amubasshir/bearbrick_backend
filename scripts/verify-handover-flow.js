#!/usr/bin/env node
/**
 * Clean verification flow for handover:
 * 1. Cast several votes on one brick (create vote_intents)
 * 2. Show count(*) from vote_events for that brick
 * 3. Run aggregator
 * 4. Show current_price, weighted_total, n_votes from brick_price_state
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const { execSync } = require("child_process");
const path = require("path");
const pricing = require("../config/pricing");

const prisma = new PrismaClient();
const BRICK_ID = "11111111-1111-4111-8111-111111111101";
const CREDITS_NEEDED = 5; // enough for 5 votes (2+2+1 per user)

function log(msg, data) {
  console.log("\n" + "=".repeat(60));
  console.log(msg);
  if (data != null) {
    const s = JSON.stringify(
      data,
      (_, v) => (typeof v === "bigint" ? Number(v) : v),
      2
    );
    console.log(s);
  }
  console.log("=".repeat(60));
}

async function ensureSeed() {
  const brick = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  const users = await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 3,
  });
  if (!brick || users.length < 2) {
    console.log("Seeding...");
    execSync("node prisma/seed.js", {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
    });
  }
  const u = await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 3,
  });
  return u;
}

async function ensureCreditsAndCleanIntents(users) {
  const userIds = users.map((u) => u.id);
  // Set enough credits for multiple runs (each user may vote multiple times)
  // Default: 20 credits per user (enough for 20 votes)
  const creditsToSet = Math.max(20, pricing.vote_credits_max || 3);
  for (const userId of userIds) {
    await prisma.userBrickVoteCredit.upsert({
      where: { userId_brickId: { userId, brickId: BRICK_ID } },
      create: { userId, brickId: BRICK_ID, creditsRemaining: creditsToSet },
      update: { creditsRemaining: creditsToSet },
    });
  }
  const deleted = await prisma.voteIntent.deleteMany({
    where: { status: "PENDING" },
  });
  if (Number(deleted.count) > 0) {
    console.log(
      `Cleaned ${deleted.count} old PENDING vote_intents so this run is deterministic.`
    );
  }
}

async function castVotes(users) {
  log("STEP 1: Cast several votes on one brick (create vote_intents)");
  const ipHash = crypto.createHash("sha256").update("127.0.0.1").digest("hex");

  // Check current state to see if we need more votes for price movement
  const currentState = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
    select: { weightedTotal: true, weightedSinceLastMove: true },
  });
  const currentWeightedTotal = Number(currentState?.weightedTotal || 0);
  const currentWeightedSinceLastMove = Number(
    currentState?.weightedSinceLastMove || 0
  );

  // Create enough votes to reach weighted_total >= 5 for price movement
  // Each vote has ~0.05 weight, so we need ~100 votes total (5 / 0.05 = 100)
  // Create batches: if current < 5, create enough to reach 5+ (max 20 per run for safety)
  const votesNeeded = Math.max(0, Math.ceil((5 - currentWeightedTotal) / 0.05));
  const votesToCreate = Math.min(Math.max(votesNeeded, 5), 20); // At least 5, max 20 per run

  const votes = [];
  for (let i = 0; i < votesToCreate; i++) {
    const userIndex = i % users.length;
    // More OVER votes to trigger upward price movement (60% OVER, 20% FAIR, 20% UNDER)
    let voteType;
    const mod = i % 5;
    if (mod < 3) voteType = "OVER"; // 60% OVER
    else if (mod === 3) voteType = "FAIR"; // 20% FAIR
    else voteType = "UNDER"; // 20% UNDER

    votes.push({
      userId: users[userIndex].id,
      voteType: voteType,
    });
  }

  for (const v of votes) {
    await prisma.voteIntent.create({
      data: {
        userId: v.userId,
        brickId: BRICK_ID,
        voteType: v.voteType,
        status: "PENDING",
        ipHash,
        userAgent: "verify-handover-flow",
      },
    });
  }
  log(`Created ${votes.length} vote_intents for brick ${BRICK_ID}`, {
    current_weighted_total: currentWeightedTotal.toFixed(2),
    current_weighted_since_last_move: currentWeightedSinceLastMove.toFixed(2),
    votes_created: votes.length,
    estimated_new_weighted_total: (
      currentWeightedTotal +
      votes.length * 0.05
    ).toFixed(2),
    will_trigger_price_move:
      currentWeightedTotal + votes.length * 0.05 >= 5
        ? "YES (if weighted_since_last_move also >= 5)"
        : "NO (need more votes)",
    votes_sample: votes
      .slice(0, 10)
      .map((v) => ({ user: Number(v.userId), vote: v.voteType })),
  });
}

async function runEnrich() {
  log("STEP 2a: Run Enrich worker (vote_intents → vote_events)");
  const out = execSync("node src/scripts/enrich-votes.js", {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  console.log(out);
}

async function showVoteEventCount() {
  log("STEP 2b: Show count(*) from vote_events for that brick");
  const n = await prisma.voteEvent.count({
    where: { brickId: BRICK_ID },
  });
  const recentEvents = await prisma.voteEvent.findMany({
    where: { brickId: BRICK_ID },
    orderBy: { id: "desc" },
    take: 5,
    select: {
      id: true,
      voteType: true,
      userWeightAtVote: true,
      cycleId: true,
      userId: true,
    },
  });
  const state = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
    select: { currentCycleId: true, freezeMode: true },
  });
  const cursor = await prisma.workerCursor.findUnique({
    where: { workerName: "price_aggregator" },
  });
  log(`COUNT(*) FROM vote_events WHERE brick_id = '${BRICK_ID}'`, {
    n_votes: n,
    brick_currentCycleId: state?.currentCycleId || null,
    brick_freezeMode: state?.freezeMode || false,
    aggregator_cursor: cursor ? Number(cursor.lastProcessedId) : null,
    recent_5_events: recentEvents.map((e) => ({
      id: Number(e.id),
      voteType: e.voteType,
      weight: Number(e.userWeightAtVote),
      cycleId: e.cycleId,
      userId: Number(e.userId),
    })),
  });
  return n;
}

async function runAggregate() {
  log("STEP 3: Run Aggregator (vote_events → brick_price_state)");
  const stateBefore = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
    select: {
      weightedUnder: true,
      weightedFair: true,
      weightedOver: true,
      weightedTotal: true,
      currentCycleId: true,
    },
  });
  const cursorBefore = await prisma.workerCursor.findUnique({
    where: { workerName: "price_aggregator" },
  });
  console.log(`State BEFORE aggregate:`, {
    weightedUnder: Number(stateBefore?.weightedUnder || 0),
    weightedFair: Number(stateBefore?.weightedFair || 0),
    weightedOver: Number(stateBefore?.weightedOver || 0),
    weightedTotal: Number(stateBefore?.weightedTotal || 0),
    currentCycleId: stateBefore?.currentCycleId,
  });
  const out = execSync("node src/scripts/aggregate-prices.js", {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  console.log(out);
  const cursorAfter = await prisma.workerCursor.findUnique({
    where: { workerName: "price_aggregator" },
  });
  const stateAfter = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
    select: {
      weightedUnder: true,
      weightedFair: true,
      weightedOver: true,
      weightedTotal: true,
      currentCycleId: true,
    },
  });
  if (cursorBefore && cursorAfter) {
    const processed =
      Number(cursorAfter.lastProcessedId) -
      Number(cursorBefore.lastProcessedId);
    console.log(
      `\nAggregator cursor moved: ${Number(
        cursorBefore.lastProcessedId
      )} → ${Number(
        cursorAfter.lastProcessedId
      )} (processed ${processed} events)`
    );
  }
  console.log(`State AFTER aggregate:`, {
    weightedUnder: Number(stateAfter?.weightedUnder || 0),
    weightedFair: Number(stateAfter?.weightedFair || 0),
    weightedOver: Number(stateAfter?.weightedOver || 0),
    weightedTotal: Number(stateAfter?.weightedTotal || 0),
    currentCycleId: stateAfter?.currentCycleId,
  });
}

async function showState() {
  log(
    "STEP 4: Show current_price, weighted_total, n_votes from brick_price_state"
  );
  const state = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  const nVotes = await prisma.voteEvent.count({
    where: { brickId: BRICK_ID },
  });
  if (!state) {
    log("No brick_price_state for brick " + BRICK_ID);
    return;
  }
  const priceMoved = Number(state.livePrice) !== 100; // Assuming starting price is 100
  const wt = Number(state.weightedTotal);
  const wslm = Number(state.weightedSinceLastMove);
  const minW = pricing.min_weighted_total_for_move ?? 5;
  const moveBatch = pricing.move_batch_size_weighted ?? 5;
  const canMove = wt >= minW && wslm >= moveBatch && !state.freezeMode;
  const reasons = [];
  if (wt < minW) reasons.push(`weighted_total (${wt.toFixed(4)}) < ${minW}`);
  if (wslm < moveBatch)
    reasons.push(
      `weighted_since_last_move (${wslm.toFixed(4)}) < ${moveBatch}`
    );
  if (state.freezeMode) reasons.push("freeze_mode is true");
  const can_move_price_reason = canMove
    ? "OK: weighted_total ≥ " +
      minW +
      ", weighted_since_last_move ≥ " +
      moveBatch +
      ", !freeze_mode"
    : "blocked: " + (reasons.length ? reasons.join("; ") : "unknown");

  log("brick_price_state (for handover verification):", {
    brick_id: BRICK_ID,
    current_price: Number(state.livePrice),
    price_changed: priceMoved
      ? `YES! (was 100, now ${Number(state.livePrice)})`
      : "NO (still 100)",
    weighted_total: wt,
    weighted_since_last_move: wslm,
    can_move_price: canMove,
    can_move_price_reason: can_move_price_reason,
    n_votes: nVotes,
    p_under: Number(state.pUnder),
    p_fair: Number(state.pFair),
    p_over: Number(state.pOver),
  });
}

async function main() {
  try {
    const users = await ensureSeed();
    await ensureCreditsAndCleanIntents(users);
    await castVotes(users);
    await runEnrich();
    await showVoteEventCount();
    await runAggregate();
    await showState();
    log(
      "VERIFICATION FLOW COMPLETE – Backend state updated deterministically after votes."
    );
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
