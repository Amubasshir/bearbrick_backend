/**
 * Trust Evaluation Worker: Processes cycle close events and scores user votes.
 * Run: node src/scripts/trust-evaluation-worker.js
 */
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const TrustService = require("../services/pricing/TrustService");
const prisma = require("../lib/prisma");
const BATCH = 100;
const WORKER_INSTANCE_ID =
  process.env.WORKER_INSTANCE_ID || `worker-${uuidv4()}`;

async function ensureJobsExist() {
  // Create jobs for any cycle close events that don't have jobs yet
  const eventsWithoutJobs = await prisma.pricingCycleCloseEvent.findMany({
    where: {
      trustWorkerJobs: {
        none: {},
      },
    },
    select: { id: true },
  });

  if (eventsWithoutJobs.length > 0) {
    await prisma.trustWorkerJob.createMany({
      data: eventsWithoutJobs.map((e) => ({
        cycleCloseEventId: e.id,
        status: "PENDING",
      })),
      skipDuplicates: true,
    });
  }
}

async function claimJob() {
  // Atomically claim one PENDING job using transaction
  const result = await prisma.$transaction(async (tx) => {
    const job = await tx.trustWorkerJob.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });

    if (!job) return null;

    const updated = await tx.trustWorkerJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        claimedBy: WORKER_INSTANCE_ID,
        claimedAt: new Date(),
        startedAt: new Date(),
      },
    });

    return updated.cycleCloseEventId;
  });

  return result ? Number(result) : null;
}

async function processCycleClose(cycleCloseEventId) {
  // Load cycle close event
  const closeEvent = await prisma.pricingCycleCloseEvent.findUnique({
    where: { id: cycleCloseEventId },
  });

  if (!closeEvent) {
    throw new Error(`Cycle close event ${cycleCloseEventId} not found`);
  }

  const { brickId, cycleId, outcome, closedAt } = closeEvent;

  // If outcome is FLAT, skip scoring (no directional truth)
  if (outcome === "FLAT") {
    return;
  }

  // Find scoring-eligible votes
  const eligibleVotes = await TrustService.findScoringEligibleVotes(
    prisma,
    brickId,
    cycleId,
    closedAt
  );

  if (eligibleVotes.length === 0) {
    return; // No votes to score
  }

  // Score each vote and create trust_score_events
  const userIds = new Set();
  for (const vote of eligibleVotes) {
    const aligned = TrustService.isAligned(vote.voteType, outcome);

    // Create trust_score_event (idempotent)
    await prisma.trustScoreEvent.upsert({
      where: {
        userId_brickId_cycleId: {
          userId: vote.userId,
          brickId: brickId,
          cycleId: cycleId,
        },
      },
      create: {
        userId: vote.userId,
        brickId: brickId,
        cycleId: cycleId,
        cycleCloseEventId: cycleCloseEventId,
        voteEventId: vote.id,
        voteType: vote.voteType,
        aligned: aligned,
        userWeightAtVote: Number(vote.userWeightAtVote),
        voteCreatedAt: vote.createdAt,
      },
      update: {}, // No update needed, already scored
    });

    userIds.add(vote.userId);
  }

  // Update user_trust_state for each impacted user
  for (const userId of userIds) {
    await prisma.$transaction(async (tx) => {
      // Ensure user_trust_state exists
      await tx.userTrustState.upsert({
        where: { userId: userId },
        create: {
          userId: userId,
          trustScore: 0.0,
          trustTier: "UNTRUSTED",
        },
        update: {},
      });

      // Load current state
      const state = await tx.userTrustState.findUnique({
        where: { userId: userId },
      });

      // Compute updated counters from all trust_score_events
      const allEvents = await tx.trustScoreEvent.findMany({
        where: { userId: userId },
      });

      const alignedVotes = allEvents.filter((e) => e.aligned).length;
      const misalignedVotes = allEvents.filter((e) => !e.aligned).length;
      const totalScoredVotes = alignedVotes + misalignedVotes;

      // Calculate trust score
      const trustScore = TrustService.calculateTrustScore(
        alignedVotes,
        misalignedVotes
      );

      // Assign tier
      const computedTier = TrustService.assignTrustTier(trustScore);

      // Check cooldown
      const cooldownUntil = await TrustService.checkCooldown(tx, userId);

      // If in cooldown, force tier to PROBATION
      const effectiveTier =
        cooldownUntil && new Date(cooldownUntil) > new Date()
          ? "PROBATION"
          : computedTier;

      // Update state
      await tx.userTrustState.update({
        where: { userId: userId },
        data: {
          trustScore: trustScore,
          trustTier: effectiveTier,
          totalScoredVotes: totalScoredVotes,
          alignedVotes: alignedVotes,
          misalignedVotes: misalignedVotes,
          cooldownUntil: cooldownUntil,
          lastScoredAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
    });
  }
}

async function markJobDone(cycleCloseEventId) {
  await prisma.trustWorkerJob.update({
    where: { cycleCloseEventId: cycleCloseEventId },
    data: {
      status: "DONE",
      finishedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function markJobFailed(cycleCloseEventId, error) {
  await prisma.trustWorkerJob.update({
    where: { cycleCloseEventId: cycleCloseEventId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: error.message || String(error),
    },
  });
}

async function main() {
  console.log(
    `Trust Evaluation Worker started (instance: ${WORKER_INSTANCE_ID})`
  );

  while (true) {
    try {
      // Ensure jobs exist for all cycle close events
      await ensureJobsExist();

      // Claim one job
      const cycleCloseEventId = await claimJob();

      if (!cycleCloseEventId) {
        // No jobs available, sleep and retry
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      // Process the job
      try {
        await processCycleClose(cycleCloseEventId);
        await markJobDone(cycleCloseEventId);
        console.log(`Processed cycle close event ${cycleCloseEventId}`);
      } catch (error) {
        console.error(
          `Error processing cycle close event ${cycleCloseEventId}:`,
          error
        );
        await markJobFailed(cycleCloseEventId, error);
      }
    } catch (error) {
      console.error("Error in main loop:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    // Worker runs indefinitely, so this won't be called unless error
  });
