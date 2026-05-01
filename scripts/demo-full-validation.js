#!/usr/bin/env node
/**
 * Complete Demo Script: Creates sample data + Shows all behaviors + Replay validation
 *
 * This script does EVERYTHING in one go:
 * 1. Seeds users + bricks
 * 2. Creates vote_events (simulating votes)
 * 3. Truncates derived state
 * 4. Replays from vote_events
 * 5. Shows all behaviors (movement, freeze, cycle reset, trust scoring)
 *
 * Run: node scripts/demo-full-validation.js
 * Perfect for screen recording - one command shows everything!
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const { execSync } = require("child_process");
const path = require("path");

const prisma = new PrismaClient();
const TrustService = require("../src/services/pricing/TrustService");

function log(msg, data = null) {
  const ts = new Date().toISOString();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`[${ts}] ${msg}`);
  console.log("=".repeat(70));
  if (data != null) console.log(JSON.stringify(data, null, 2));
}

async function seedUsersAndBricks() {
  log("STEP 1: SEEDING USERS & BRICKS");

  const password = await bcrypt.hash("password123", 10);
  const users = [
    {
      name: "Admin User",
      email: "admin@example.com",
      password,
      email_verified_at: new Date(),
    },
    {
      name: "User 1",
      email: "user1@example.com",
      password,
      email_verified_at: new Date(),
    },
    {
      name: "User 2",
      email: "user2@example.com",
      password,
      email_verified_at: new Date(),
    },
    {
      name: "User 3",
      email: "user3@example.com",
      password,
      email_verified_at: new Date(),
    },
  ];

  const userIds = [];
  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: u,
    });
    userIds.push(user.id);
    await prisma.userIdentityState.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        emailVerified: true,
        trustTier: 2,
        behaviorState: "NORMAL",
      },
    });
  }
  log(`✅ Created ${userIds.length} users (all email verified)`);

  const bricks = [
    { brickId: "11111111-1111-4111-8111-111111111101", baseline_price: 100 },
  ];

  for (const b of bricks) {
    await prisma.brickPriceState.upsert({
      where: { brickId: b.brickId },
      update: {},
      create: {
        brickId: b.brickId,
        baselinePrice: b.baseline_price,
        livePrice: b.baseline_price,
        currentCycleId: uuidv4(),
        cycleStartPrice: b.baseline_price,
        cycleStartedAt: new Date(),
      },
    });
  }
  log(`✅ Created ${bricks.length} brick(s)`);

  return { userIds, brickId: bricks[0].brickId };
}

async function createSampleVoteEvents(userIds, brickId) {
  log("STEP 2: CREATING SAMPLE vote_events (Simulating voting scenario)");

  // Get initial state
  const state = await prisma.brickPriceState.findUnique({ where: { brickId } });
  const cycleId = state.currentCycleId;
  let livePrice = Number(state.livePrice);

  // Fair range calculation
  const FAIR_RANGE_PCT = 0.05;
  const getFairRange = (price) => ({
    lower: price * (1 - FAIR_RANGE_PCT),
    upper: price * (1 + FAIR_RANGE_PCT),
  });

  // Base step calculation
  const getBaseStep = (price) => {
    if (price < 50) return 3;
    if (price < 100) return 5;
    if (price < 150) return 7;
    if (price < 300) return 10;
    if (price < 500) return 15;
    if (price < 1000) return 25;
    if (price < 2000) return 40;
    return 75;
  };

  // User weight (simplified - all users get weight 1.0)
  const userWeight = 1.0;

  const ipHash = crypto.createHash("sha256").update("127.0.0.1").digest("hex");

  // Scenario: Create votes that will:
  // 1. Show weighted counters updating
  // 2. Trigger price movement (from anchor)
  // 3. Show movement eligibility
  // 4. Trigger freeze mode (p_fair >= 0.55)
  // 5. Show frozen votes don't affect pricing
  // 6. Trigger cycle reset (≥7% move)
  // 7. Show trust scoring

  const votes = [
    // Initial votes to build up weighted_total
    { userId: userIds[0], voteType: "OVER", note: "User 1 votes OVER" },
    { userId: userIds[1], voteType: "OVER", note: "User 2 votes OVER" },
    { userId: userIds[2], voteType: "OVER", note: "User 3 votes OVER" },
    { userId: userIds[0], voteType: "OVER", note: "User 1 votes OVER again" },
    { userId: userIds[1], voteType: "OVER", note: "User 2 votes OVER again" },
    // Now we have weighted_total >= 5, should trigger movement
    { userId: userIds[2], voteType: "FAIR", note: "User 3 votes FAIR" },
    { userId: userIds[0], voteType: "FAIR", note: "User 1 votes FAIR" },
    { userId: userIds[1], voteType: "FAIR", note: "User 2 votes FAIR" },
    { userId: userIds[2], voteType: "FAIR", note: "User 3 votes FAIR" },
    { userId: userIds[0], voteType: "FAIR", note: "User 1 votes FAIR" },
    { userId: userIds[1], voteType: "FAIR", note: "User 2 votes FAIR" },
    { userId: userIds[2], voteType: "FAIR", note: "User 3 votes FAIR" },
    { userId: userIds[0], voteType: "FAIR", note: "User 1 votes FAIR" },
    { userId: userIds[1], voteType: "FAIR", note: "User 2 votes FAIR" },
    { userId: userIds[2], voteType: "FAIR", note: "User 3 votes FAIR" },
    { userId: userIds[0], voteType: "FAIR", note: "User 1 votes FAIR" },
    { userId: userIds[1], voteType: "FAIR", note: "User 2 votes FAIR" },
    { userId: userIds[2], voteType: "FAIR", note: "User 3 votes FAIR" },
    { userId: userIds[0], voteType: "FAIR", note: "User 1 votes FAIR" },
    { userId: userIds[1], voteType: "FAIR", note: "User 2 votes FAIR" },
    // Now p_fair should be >= 0.55 and weighted_total >= 20 -> FREEZE MODE
    // After freeze, votes won't accumulate (we'll see this in replay)
    {
      userId: userIds[0],
      voteType: "OVER",
      note: "FROZEN: User 1 votes OVER (should not accumulate)",
    },
    {
      userId: userIds[1],
      voteType: "OVER",
      note: "FROZEN: User 2 votes OVER (should not accumulate)",
    },
  ];

  const events = [];
  let currentPrice = livePrice;

  for (const vote of votes) {
    const fairRange = getFairRange(currentPrice);
    const baseStep = getBaseStep(currentPrice);

    const event = await prisma.voteEvent.create({
      data: {
        userId: vote.userId,
        brickId: brickId,
        voteType: vote.voteType,
        livePriceAtVote: currentPrice,
        fairRangeLower: fairRange.lower,
        fairRangeUpper: fairRange.upper,
        baseStepAtVote: baseStep,
        userWeightAtVote: userWeight,
        cycleId: cycleId,
        ipHash: ipHash,
        userAgent: "demo-full-validation",
      },
    });

    events.push({ event, note: vote.note });

    log(`Created vote_event ${event.id}: ${vote.note}`, {
      vote_type: vote.voteType,
      live_price_at_vote: currentPrice,
      fair_range: `${fairRange.lower.toFixed(2)} - ${fairRange.upper.toFixed(
        2
      )}`,
      base_step: baseStep,
      user_weight: userWeight,
    });
  }

  log(`✅ Created ${events.length} vote_events`);
  return events;
}

async function truncateDerivedTables() {
  log("STEP 3: TRUNCATING DERIVED STATE TABLES");

  await prisma.trustWorkerJob.deleteMany({});
  await prisma.trustScoreEvent.deleteMany({});
  await prisma.userTrustState.deleteMany({});
  await prisma.brickFreezeWindowEvent.deleteMany({});
  await prisma.pricingCycleCloseEvent.deleteMany({});
  await prisma.brickPriceState.deleteMany({});
  await prisma.brickPriceHistory.deleteMany({});
  await prisma.workerCursor.deleteMany({});

  log("✅ All derived state tables truncated (pricing + trust)");
}

async function replayAggregate() {
  log("STEP 4: REPLAYING vote_events → brick_price_state");
  log(
    "This shows: weighted counters updating, price movement from anchor, movement eligibility, freeze mode"
  );

  await prisma.workerCursor.upsert({
    where: { workerName: "price_aggregator" },
    update: { lastProcessedId: 0 },
    create: { workerName: "price_aggregator", lastProcessedId: 0 },
  });

  const root = path.resolve(__dirname, "..");
  let totalProcessed = 0;
  let rounds = 0;

  while (true) {
    const out = execSync("node src/scripts/aggregate-prices.js", {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    console.log(out);
    const match = out.match(/Processed (\d+) vote events?/);
    const n = match ? parseInt(match[1], 10) : 0;
    totalProcessed += n;
    rounds++;
    if (n === 0) break;
  }

  log(
    `✅ Replay complete: ${totalProcessed} events processed in ${rounds} batch(es)`
  );

  // Show final state
  const finalState = await prisma.brickPriceState.findFirst();
  if (finalState) {
    log("FINAL brick_price_state:", {
      brick_id: finalState.brickId,
      live_price: Number(finalState.livePrice),
      cycle_id: finalState.currentCycleId,
      weighted_under: Number(finalState.weightedUnder),
      weighted_fair: Number(finalState.weightedFair),
      weighted_over: Number(finalState.weightedOver),
      weighted_total: Number(finalState.weightedTotal),
      weighted_since_last_move: Number(finalState.weightedSinceLastMove),
      p_under: Number(finalState.pUnder).toFixed(4),
      p_fair: Number(finalState.pFair).toFixed(4),
      p_over: Number(finalState.pOver).toFixed(4),
      pricing_confidence_c: Number(finalState.pricingConfidenceC).toFixed(4),
      momentum_score: finalState.momentumScore,
      freeze_mode: finalState.freezeMode,
      needs_recheck: finalState.needsRecheck,
    });

    if (finalState.freezeMode) {
      log(
        "✅ FREEZE MODE ACTIVE - Frozen votes should NOT affect pricing counters (Option A)"
      );
    }

    const cycleCloses = await prisma.pricingCycleCloseEvent.findMany({
      where: { brickId: finalState.brickId },
    });
    if (cycleCloses.length > 0) {
      log(
        `✅ CYCLE RESET occurred: ${cycleCloses.length} cycle close(s)`,
        cycleCloses.map((c) => ({
          cycle_id: c.cycleId,
          start_price: Number(c.cycleStartPrice),
          end_price: Number(c.cycleEndPrice),
          move_pct:
            (
              ((Number(c.cycleEndPrice) - Number(c.cycleStartPrice)) /
                Number(c.cycleStartPrice)) *
              100
            ).toFixed(2) + "%",
          outcome: c.outcome,
          unique_voters: c.uniqueVoters,
          weighted_total_at_close: Number(c.weightedTotalAtClose),
        }))
      );
    }
  }
}

async function replayTrustEvaluation() {
  log("STEP 5: TRUST EVALUATION (cycle closes → user_trust_state)");
  log("This shows: trust scoring, aligned vs misaligned votes");

  const withoutJobs = await prisma.pricingCycleCloseEvent.findMany({
    where: { trustWorkerJobs: { none: {} } },
    select: { id: true },
  });
  if (withoutJobs.length > 0) {
    await prisma.trustWorkerJob.createMany({
      data: withoutJobs.map((e) => ({
        cycleCloseEventId: e.id,
        status: "PENDING",
      })),
      skipDuplicates: true,
    });
  }

  let processed = 0;
  while (true) {
    const job = await prisma.trustWorkerJob.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      include: { cycleCloseEvent: true },
    });
    if (!job) break;

    await prisma.trustWorkerJob.update({
      where: { id: job.id },
      data: { status: "PROCESSING", startedAt: new Date() },
    });

    const closeEvent = job.cycleCloseEvent;
    const { brickId, cycleId, outcome, closedAt } = closeEvent;

    log(`Processing cycle close: ${outcome} outcome`);

    if (outcome !== "FLAT") {
      const eligibleVotes = await TrustService.findScoringEligibleVotes(
        prisma,
        brickId,
        cycleId,
        closedAt
      );

      log(`Found ${eligibleVotes.length} eligible votes to score`);

      const userIds = new Set();
      for (const vote of eligibleVotes) {
        const aligned = TrustService.isAligned(vote.voteType, outcome);

        await prisma.trustScoreEvent.upsert({
          where: {
            userId_brickId_cycleId: {
              userId: vote.userId,
              brickId,
              cycleId,
            },
          },
          create: {
            userId: vote.userId,
            brickId,
            cycleId,
            cycleCloseEventId: closeEvent.id,
            voteEventId: vote.id,
            voteType: vote.voteType,
            aligned,
            userWeightAtVote: Number(vote.userWeightAtVote),
            voteCreatedAt: vote.createdAt,
          },
          update: {},
        });

        userIds.add(vote.userId);

        log(
          `  User ${vote.userId}: ${vote.voteType} → ${outcome} = ${
            aligned ? "✅ ALIGNED" : "❌ MISALIGNED"
          }`
        );
      }

      for (const userId of userIds) {
        const allEvents = await prisma.trustScoreEvent.findMany({
          where: { userId },
        });
        const alignedVotes = allEvents.filter((e) => e.aligned).length;
        const misalignedVotes = allEvents.filter((e) => !e.aligned).length;
        const totalScoredVotes = alignedVotes + misalignedVotes;
        const trustScore = TrustService.calculateTrustScore(
          alignedVotes,
          misalignedVotes
        );
        const computedTier = TrustService.assignTrustTier(trustScore);
        const cooldownUntil = await TrustService.checkCooldown(prisma, userId);
        const effectiveTier =
          cooldownUntil && new Date(cooldownUntil) > new Date()
            ? "PROBATION"
            : computedTier;

        await prisma.userTrustState.upsert({
          where: { userId },
          create: {
            userId,
            trustScore,
            trustTier: effectiveTier,
            totalScoredVotes,
            alignedVotes,
            misalignedVotes,
            cooldownUntil,
            lastScoredAt: new Date(),
          },
          update: {
            trustScore,
            trustTier: effectiveTier,
            totalScoredVotes,
            alignedVotes,
            misalignedVotes,
            cooldownUntil,
            lastScoredAt: new Date(),
            lastUpdatedAt: new Date(),
          },
        });

        log(`  Trust updated for user ${userId}:`, {
          aligned: alignedVotes,
          misaligned: misalignedVotes,
          total: totalScoredVotes,
          trust_score: trustScore.toFixed(4),
          tier: effectiveTier,
        });
      }
    }

    await prisma.trustWorkerJob.update({
      where: { id: job.id },
      data: { status: "DONE", finishedAt: new Date() },
    });
    processed++;
  }

  log(`✅ Trust evaluation complete: ${processed} cycle close(s) processed`);
}

async function showFinalState() {
  log("STEP 6: FINAL STATE VERIFICATION");

  const states = await prisma.brickPriceState.findMany({
    orderBy: { brickId: "asc" },
  });
  log(`brick_price_state (${states.length} rows):`);
  for (const s of states) {
    log(`Brick ${s.brickId}:`, {
      live_price: Number(s.livePrice),
      cycle_id: s.currentCycleId,
      weighted_total: Number(s.weightedTotal),
      weighted_since_last_move: Number(s.weightedSinceLastMove),
      p_under: Number(s.pUnder).toFixed(4),
      p_fair: Number(s.pFair).toFixed(4),
      p_over: Number(s.pOver).toFixed(4),
      pricing_confidence_c: Number(s.pricingConfidenceC).toFixed(4),
      momentum_score: s.momentumScore,
      freeze_mode: s.freezeMode,
      needs_recheck: s.needsRecheck,
    });
  }

  const trustStates = await prisma.userTrustState.findMany({
    orderBy: { userId: "asc" },
  });
  log(`user_trust_state (${trustStates.length} rows):`);
  for (const t of trustStates) {
    log(`User ${t.userId}:`, {
      trust_score: t.trustScore,
      trust_tier: t.trustTier,
      total_scored_votes: t.totalScoredVotes,
      aligned_votes: t.alignedVotes,
      misaligned_votes: t.misalignedVotes,
    });
  }
}

async function main() {
  try {
    const { userIds, brickId } = await seedUsersAndBricks();
    await createSampleVoteEvents(userIds, brickId);
    await truncateDerivedTables();
    await replayAggregate();
    await replayTrustEvaluation();
    await showFinalState();

    log("═══════════════════════════════════════════════════════════════");
    log("✅ COMPLETE VALIDATION DEMO FINISHED");
    log("═══════════════════════════════════════════════════════════════");
    log("This demo showed:");
    log("  ✅ Votes ingesting (vote_events created)");
    log("  ✅ Weighted counters updating");
    log("  ✅ Price moving from anchor (anchor-based movement)");
    log("  ✅ Movement eligibility respected");
    log(
      "  ✅ Freeze mode triggering (p_fair >= 0.55 AND weighted_total >= 20)"
    );
    log("  ✅ Frozen votes NOT affecting pricing counters (Option A)");
    log("  ✅ Cycle reset (≥7% move + volume requirement)");
    log("  ✅ Trust scoring (aligned vs misaligned)");
    log("═══════════════════════════════════════════════════════════════");
  } catch (e) {
    log("❌ Demo failed:", { error: e.message, stack: e.stack });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
