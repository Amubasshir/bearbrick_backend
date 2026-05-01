/**
 * Recheck Worker: Evaluates recheck triggers and manages recheck state machine.
 * Run: node src/scripts/recheck-worker.js
 */
require("dotenv").config();
const RecheckService = require("../services/pricing/RecheckService");
const FreezeService = require("../services/pricing/FreezeService");
const pricing = require("../../config/pricing");
const prisma = require("../lib/prisma");
const PAGE_SIZE = 500;
const RUN_INTERVAL_MIN =
  parseInt(process.env.RECHECK_WORKER_INTERVAL_MIN, 10) || 60;

async function acquireAdvisoryLock() {
  // Use PostgreSQL advisory lock to ensure only one instance runs
  const result = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(123456) as acquired
  `;
  return result[0].acquired;
}

async function releaseAdvisoryLock() {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(123456)
  `;
}

function inRecheckCooldown(state) {
  if (!state.recheckStartedAt) return false;
  const daysSince =
    (Date.now() - new Date(state.recheckStartedAt)) / (24 * 60 * 60 * 1000);
  return daysSince < pricing.recheck_cooldown_days;
}

function freezeShouldTriggerRecheck(state) {
  if (!state.freezeMode) return false;

  // If freeze_until exists and passed
  if (state.freezeUntil && new Date() > new Date(state.freezeUntil)) {
    return true;
  }

  // Safety max: if freeze older than max days
  const freezeAgeDays =
    (Date.now() - new Date(state.lastPriceUpdate)) / (24 * 60 * 60 * 1000);
  if (freezeAgeDays >= pricing.freeze_duration_days_max) {
    return true;
  }

  return false;
}

async function processBrick(state) {
  // Skip if in cooldown
  if (inRecheckCooldown(state)) {
    return;
  }

  // If needs_recheck already true and window not expired, do nothing
  if (
    state.needsRecheck &&
    state.recheckExpiresAt &&
    new Date() < new Date(state.recheckExpiresAt)
  ) {
    return;
  }

  // If needs_recheck true but expired, clear it
  if (
    state.needsRecheck &&
    state.recheckExpiresAt &&
    new Date() >= new Date(state.recheckExpiresAt)
  ) {
    await prisma.brickPriceState.update({
      where: { brickId: state.brickId },
      data: RecheckService.resolveRecheck(),
    });
    // Continue to evaluate fresh triggers
  }

  // Check if ACTIVE should downgrade to WATCH
  if (RecheckService.shouldDowngradeActive(state)) {
    await prisma.brickPriceState.update({
      where: { brickId: state.brickId },
      data: RecheckService.downgradeActive(),
    });
    return;
  }

  // Evaluate triggers in priority order
  let triggerReason = null;
  let triggerState = "WATCH";

  // PRIORITY 1: Freeze timeout
  if (freezeShouldTriggerRecheck(state)) {
    triggerReason = "FREEZE_EXIT";
    triggerState = "ACTIVE";
  }
  // PRIORITY 2: Stale confidence
  else if (RecheckService.triggerA_StaleConfidence(state)) {
    triggerReason = "STALE";
    triggerState = "WATCH";
  }
  // PRIORITY 3: Low participation
  else if (await RecheckService.triggerB_LowSample(prisma, state)) {
    triggerReason = "LOW_SAMPLE";
    triggerState = "WATCH";
  }
  // PRIORITY 4: Opposing signal
  else if (RecheckService.triggerC_OpposingSignal(state)) {
    triggerReason = "OPPOSING_SIGNAL";
    triggerState = "WATCH";
  }

  // Activate recheck if trigger fired
  if (triggerReason) {
    const updates = RecheckService.enterRecheck(
      state,
      triggerReason,
      triggerState
    );

    // Handle freeze exit if needed
    if (state.freezeMode && triggerState === "ACTIVE") {
      Object.assign(updates, FreezeService.exitFreeze());
    }

    await prisma.brickPriceState.update({
      where: { brickId: state.brickId },
      data: updates,
    });
  }
}

async function processBricksPage(lastBrickId) {
  const bricks = await prisma.brickPriceState.findMany({
    take: PAGE_SIZE,
    where: lastBrickId ? { brickId: { gt: lastBrickId } } : undefined,
    orderBy: { brickId: "asc" },
  });

  for (const brick of bricks) {
    try {
      await processBrick(brick);
    } catch (error) {
      console.error(`Error processing brick ${brick.brickId}:`, error);
    }
  }

  return bricks.length > 0 ? bricks[bricks.length - 1].brickId : null;
}

async function main() {
  console.log("Recheck Worker started");

  while (true) {
    try {
      const acquired = await acquireAdvisoryLock();
      if (!acquired) {
        console.log("Another instance is running, waiting...");
        await new Promise((resolve) =>
          setTimeout(resolve, RUN_INTERVAL_MIN * 60 * 1000)
        );
        continue;
      }

      try {
        let lastBrickId = null;
        let processed = 0;

        while (true) {
          const nextBrickId = await processBricksPage(lastBrickId);
          if (!nextBrickId) break;
          lastBrickId = nextBrickId;
          processed += PAGE_SIZE;
        }

        console.log(`Processed bricks (last: ${lastBrickId || "none"})`);
      } finally {
        await releaseAdvisoryLock();
      }

      // Sleep until next run
      await new Promise((resolve) =>
        setTimeout(resolve, RUN_INTERVAL_MIN * 60 * 1000)
      );
    } catch (error) {
      console.error("Error in main loop:", error);
      await new Promise((resolve) => setTimeout(resolve, 60000)); // Wait 1 min on error
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    // Worker runs indefinitely
  });
