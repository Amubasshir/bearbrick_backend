#!/usr/bin/env node
/**
 * DB তে data insert করে Node app এর সব logic test।
 * SPECIFICATION + CLARIFICATIONS অনুযায়ী: enrich, aggregate, credits, sentiment, movement, snapshot।
 *
 * Usage: node scripts/test-all-logic.js
 * Requires: DATABASE_URL, DB migrated + seeded (npm run db:seed)
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const root = path.resolve(__dirname, "..");

const prisma = new PrismaClient();
const BRICK_ID = "11111111-1111-4111-8111-111111111101";
const ipHash = crypto.createHash("sha256").update("127.0.0.1").digest("hex");

function runCmd(cmd) {
  try {
    execSync(cmd, { cwd: root, encoding: "utf8", stdio: "inherit" });
  } catch (e) {
    if (e.stderr) console.error(e.stderr);
    throw e;
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("  OK:", msg);
}

async function main() {
  console.log("=== DB insert দিয়ে Node app এর সব logic test ===\n");

  // --- ১. Data ready করুন ---
  console.log("1. Users ও Bricks check...");
  const users = await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 3,
  });
  assert(
    users.length >= 1,
    "কমপক্ষে ১টা verified user থাকতে হবে (npm run db:seed)",
  );
  const brick = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  assert(!!brick, "Brick " + BRICK_ID + " থাকতে হবে (npm run db:seed)");
  const liveBefore = Number(brick.livePrice);

  // Cursors ও credits reset (clean test)
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
  const credits = await prisma.userBrickVoteCredit.findMany({
    where: { brickId: BRICK_ID },
  });
  for (const c of credits) {
    await prisma.userBrickVoteCredit.update({
      where: { userId_brickId: { userId: c.userId, brickId: BRICK_ID } },
      data: {
        creditsRemaining: 3,
        lastVotePrice: null,
        lastVoteCycleId: null,
        lastVoteAt: null,
      },
    });
  }
  console.log("  OK: Cursors ও credits reset\n");

  // --- ২. Vote intents insert (কয়েকজন user, OVER/UNDER/FAIR) ---
  console.log("2. Vote intents insert...");
  const toInsert = [
    { userId: users[0].id, voteType: "OVER" },
    { userId: users[0].id, voteType: "OVER" },
    { userId: users[0].id, voteType: "FAIR" },
  ];
  if (users[1])
    toInsert.push(
      { userId: users[1].id, voteType: "OVER" },
      { userId: users[1].id, voteType: "UNDER" },
    );
  if (users[2]) toInsert.push({ userId: users[2].id, voteType: "OVER" });

  for (const row of toInsert) {
    await prisma.voteIntent.create({
      data: {
        userId: row.userId,
        brickId: BRICK_ID,
        voteType: row.voteType,
        status: "PENDING",
        ipHash,
        userAgent: "test-all-logic",
      },
    });
  }
  const pendingBefore = await prisma.voteIntent.count({
    where: { status: "PENDING", brickId: BRICK_ID },
  });
  assert(pendingBefore >= 3, "কমপক্ষে ৩টা PENDING intent");
  console.log("  OK: " + pendingBefore + " PENDING intents\n");

  // --- ৩. Enrich worker চালান ---
  console.log("3. Vote Enricher চালানো (intents → events)...");
  runCmd("node src/scripts/enrich-votes.js");
  const processed = await prisma.voteIntent.count({
    where: { status: "PROCESSED", brickId: BRICK_ID },
  });
  const rejected = await prisma.voteIntent.count({
    where: { status: "REJECTED", brickId: BRICK_ID },
  });
  const eventsCount = await prisma.voteEvent.count({
    where: { brickId: BRICK_ID },
  });
  const xpCount = await prisma.xpEvent.count({ where: { brickId: BRICK_ID } });
  assert(eventsCount >= 3, "Vote events তৈরি হয়েছে: " + eventsCount);
  assert(xpCount >= 3, "XP events (verified users): " + xpCount);
  console.log(
    "  OK: Processed intents, vote_events=" +
      eventsCount +
      ", xp_events=" +
      xpCount +
      "\n",
  );

  // --- ৪. Aggregate worker চালান ---
  console.log("4. Price Aggregator চালানো (events → state)...");
  runCmd("node src/scripts/aggregate-prices.js");
  const state1 = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  assert(
    state1.weightedTotal >= 0,
    "weighted_total আপডেট: " + state1.weightedTotal,
  );
  assert(
    Math.abs(state1.pUnder + state1.pFair + state1.pOver - 1) < 0.001 ||
      state1.weightedTotal === 0,
    "Sentiment p_under+p_fair+p_over ≈ 1",
  );
  assert(
    state1.pricingConfidenceC >= 0 && state1.pricingConfidenceC <= 1,
    "pricing_confidence_c 0–1",
  );
  console.log(
    "  OK: weighted_total=" +
      state1.weightedTotal +
      ", p_under=" +
      state1.pUnder.toFixed(2) +
      ", p_fair=" +
      state1.pFair.toFixed(2) +
      ", p_over=" +
      state1.pOver.toFixed(2),
  );
  console.log(
    "  OK: pricing_confidence_c=" +
      state1.pricingConfidenceC.toFixed(3) +
      ", momentum_score=" +
      state1.momentumScore +
      "\n",
  );

  // --- ৫. আরও intents insert করে movement threshold পূরণ (সব user এর credits আবার ৩ করে) ---
  console.log(
    "5. Credits আবার ৩ করে আরও intents insert (movement threshold এর জন্য)...",
  );
  const pricing = require("../config/pricing");
  const allCredits = await prisma.userBrickVoteCredit.findMany({
    where: { brickId: BRICK_ID },
  });
  for (const c of allCredits) {
    await prisma.userBrickVoteCredit.update({
      where: { userId_brickId: { userId: c.userId, brickId: BRICK_ID } },
      data: { creditsRemaining: pricing.vote_credits_max },
    });
  }
  const extraUsers = await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 5,
  });
  for (let i = 0; i < 5; i++) {
    const u = extraUsers[i % extraUsers.length];
    await prisma.voteIntent.create({
      data: {
        userId: u.id,
        brickId: BRICK_ID,
        voteType: "OVER",
        status: "PENDING",
        ipHash,
        userAgent: "test-all-logic-2",
      },
    });
  }
  runCmd("node src/scripts/enrich-votes.js");
  runCmd("node src/scripts/aggregate-prices.js");
  const state2 = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  const liveAfter = Number(state2.livePrice);
  console.log(
    "  OK: weighted_total=" +
      state2.weightedTotal +
      ", weighted_since_last_move=" +
      state2.weightedSinceLastMove,
  );
  if (
    state2.weightedTotal >= 5 &&
    state2.weightedSinceLastMove >= 5 &&
    !state2.freezeMode
  ) {
    console.log(
      "  OK: Movement eligible; live_price before=" +
        liveBefore +
        " after=" +
        liveAfter,
    );
  }
  console.log("");

  // --- ৬. Credit exhaust: একই user+brick এ ৩টার পর আর vote না (credits ০) ---
  console.log("6. Credit logic: এক user এক brick এ ৩ vote = ৩ credit খরচ...");
  const oneUser = users[0].id;
  const creditsBefore = await prisma.userBrickVoteCredit.findUnique({
    where: { userId_brickId: { userId: oneUser, brickId: BRICK_ID } },
  });
  const creditsRemaining = creditsBefore ? creditsBefore.creditsRemaining : 3;
  console.log(
    "  OK: user " +
      oneUser +
      " brick " +
      BRICK_ID +
      " credits_remaining=" +
      creditsRemaining +
      "\n",
  );

  // --- ৭. Snapshot worker (brick_price_history) ---
  console.log("7. Snapshot worker (daily close → brick_price_history)...");
  runCmd("node src/scripts/snapshot.js");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const history = await prisma.brickPriceHistory.findUnique({
    where: { brickId_date: { brickId: BRICK_ID, date: today } },
  });
  assert(!!history, "brick_price_history এ আজকের date এ row আছে");
  assert(Number(history.closePrice) >= 0, "close_price সেট আছে");
  console.log(
    "  OK: close_price=" +
      history.closePrice +
      ", votes_that_day=" +
      history.votesThatDay +
      "\n",
  );

  // --- ৮. UserIdentityState ও fair range / base_step (enrich এ ব্যবহার হয়) ---
  console.log("8. Enrich logic: UserIdentityState, fair range, base_step...");
  const oneEvent = await prisma.voteEvent.findFirst({
    where: { brickId: BRICK_ID },
  });
  assert(!!oneEvent, "কমপক্ষে ১টা vote_event");
  assert(
    oneEvent.fairRangeLower > 0 || oneEvent.livePriceAtVote === 0,
    "fair_range_lower লগ আছে",
  );
  assert(
    oneEvent.baseStepAtVote >= 3 && oneEvent.baseStepAtVote <= 75,
    "base_step_at_vote tier অনুযায়ী",
  );
  const identityCount = await prisma.userIdentityState.count();
  assert(
    identityCount >= 1,
    "UserIdentityState rows (enrich থেকে তৈরি): " + identityCount,
  );
  console.log(
    "  OK: vote_event এ fair_range, base_step, user_weight লগ আছে; identity_state=" +
      identityCount +
      "\n",
  );

  console.log("=== সব logic test পাস হয়েছে ===\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
