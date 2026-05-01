#!/usr/bin/env node
/**
 * Validation: Truncate derived state, replay from vote_events, verify state.
 * Run: node scripts/validate-replay.js [--verbose]
 * Use --verbose for detailed per-event logging (e.g. for screen recording).
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { execSync } = require("child_process");
const path = require("path");

const prisma = new PrismaClient();
const TrustService = require("../src/services/pricing/TrustService");

const verbose =
  process.argv.includes("--verbose") || process.argv.includes("-v");

function log(msg, data = null) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  if (data != null) console.log(JSON.stringify(data, null, 2));
}

async function truncateDerivedTables() {
  log("═══════════════════════════════════════════════════════════════");
  log("STEP 1: TRUNCATING DERIVED STATE TABLES");
  log("═══════════════════════════════════════════════════════════════");

  await prisma.trustWorkerJob.deleteMany({});
  await prisma.trustScoreEvent.deleteMany({});
  await prisma.userTrustState.deleteMany({});
  await prisma.brickFreezeWindowEvent.deleteMany({});
  await prisma.pricingCycleCloseEvent.deleteMany({});
  await prisma.brickPriceState.deleteMany({});
  await prisma.brickPriceHistory.deleteMany({});
  await prisma.workerCursor.deleteMany({});

  log("✅ Derived tables truncated (pricing + trust).");
}

async function resetCursorAndReplayAggregate() {
  log("═══════════════════════════════════════════════════════════════");
  log("STEP 2: RESET CURSOR & REPLAY vote_events → brick_price_state");
  log("═══════════════════════════════════════════════════════════════");

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
    if (verbose) console.log(out);
    const match = out.match(/Processed (\d+) vote events?/);
    const n = match ? parseInt(match[1], 10) : 0;
    totalProcessed += n;
    rounds++;
    if (n === 0) break;
  }

  log(`✅ Replay complete: ${totalProcessed} events in ${rounds} batch(es).`);
  return totalProcessed;
}

async function ensureTrustJobsAndProcess() {
  log("═══════════════════════════════════════════════════════════════");
  log("STEP 3: TRUST EVALUATION (cycle closes → user_trust_state)");
  log("═══════════════════════════════════════════════════════════════");

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
    log(`Created ${withoutJobs.length} trust job(s).`);
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

    if (outcome !== "FLAT") {
      const eligibleVotes = await TrustService.findScoringEligibleVotes(
        prisma,
        brickId,
        cycleId,
        closedAt
      );
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
        if (verbose) {
          log(
            `  User ${vote.userId}: ${vote.voteType} → ${outcome} = ${
              aligned ? "ALIGNED" : "MISALIGNED"
            }`
          );
        }
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
      }
    }

    await prisma.trustWorkerJob.update({
      where: { id: job.id },
      data: { status: "DONE", finishedAt: new Date() },
    });
    processed++;
  }

  log(`✅ Trust evaluation complete: ${processed} cycle close(s) processed.`);
}

async function verifyState() {
  log("═══════════════════════════════════════════════════════════════");
  log("STEP 4: REBUILT STATE (brick_price_state, user_trust_state)");
  log("═══════════════════════════════════════════════════════════════");

  const states = await prisma.brickPriceState.findMany({
    orderBy: { brickId: "asc" },
  });
  log(`brick_price_state (${states.length} rows):`);
  for (const s of states) {
    log(`  ${s.brickId}:`, {
      live_price: Number(s.livePrice),
      cycle_id: s.currentCycleId,
      weighted_total: Number(s.weightedTotal),
      weighted_since_last_move: Number(s.weightedSinceLastMove),
      p_under: Number(s.pUnder),
      p_fair: Number(s.pFair),
      p_over: Number(s.pOver),
      pricing_confidence_c: Number(s.pricingConfidenceC),
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
    log(`  user ${t.userId}:`, {
      trust_score: t.trustScore,
      trust_tier: t.trustTier,
      total_scored_votes: t.totalScoredVotes,
      aligned_votes: t.alignedVotes,
      misaligned_votes: t.misalignedVotes,
    });
  }
  log("✅ Verification complete.");
}

async function main() {
  try {
    await truncateDerivedTables();
    await resetCursorAndReplayAggregate();
    await ensureTrustJobsAndProcess();
    await verifyState();
    log("═══════════════════════════════════════════════════════════════");
    log("✅ VALIDATION COMPLETE");
    log("═══════════════════════════════════════════════════════════════");
  } catch (e) {
    log("❌ Validation failed:", { error: e.message });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
