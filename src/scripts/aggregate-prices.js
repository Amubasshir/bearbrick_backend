/**
 * Worker: vote_events -> brick_price_state (spec Appendix B - Price Aggregator)
 * Run: node src/scripts/aggregate-prices.js
 */
require("dotenv").config();
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const BATCH = 500;

const SentimentService = require("../services/pricing/SentimentService");
const ConfidenceService = require("../services/pricing/ConfidenceService");
const ReliabilityService = require("../services/pricing/ReliabilityService");
const MovementEligibilityService = require("../services/pricing/MovementEligibilityService");
const IntensityService = require("../services/pricing/IntensityService");
const CapService = require("../services/pricing/CapService");
const MomentumService = require("../services/pricing/MomentumService");
const AnchorService = require("../services/pricing/AnchorService");
const CycleService = require("../services/pricing/CycleService");
const FreezeService = require("../services/pricing/FreezeService");
const OrderAwareService = require("../services/pricing/OrderAwareService");
const RecheckService = require("../services/pricing/RecheckService");
const InfluenceCapService = require("../services/pricing/InfluenceCapService");

async function getCursor() {
  const c = await prisma.workerCursor.upsert({
    where: { workerName: "price_aggregator" },
    update: {},
    create: { workerName: "price_aggregator", lastProcessedId: 0 },
  });
  return Number(c.lastProcessedId);
}

async function updateCursor(id) {
  await prisma.workerCursor.upsert({
    where: { workerName: "price_aggregator" },
    update: { lastProcessedId: id },
    create: { workerName: "price_aggregator", lastProcessedId: id },
  });
}

async function processEvent(ev) {
  // Use transaction to ensure atomic read-modify-write
  return await prisma.$transaction(async (tx) => {
    // Lock the row with FOR UPDATE to prevent race conditions during concurrent processing
    await tx.$queryRawUnsafe(
      `SELECT * FROM brick_price_state WHERE brick_id = $1 FOR UPDATE`,
      ev.brickId
    );

    let state = await tx.brickPriceState.findFirst({
      where: { brickId: ev.brickId },
    });

    if (!state) {
      state = await tx.brickPriceState.create({
        data: {
          brickId: ev.brickId,
          livePrice: ev.livePriceAtVote,
          currentCycleId: ev.cycleId,
          cycleStartPrice: ev.livePriceAtVote,
          cycleStartedAt: new Date(),
        },
      });
    }

    if (ev.cycleId !== state.currentCycleId) return;
    if (state.freezeMode) return;

    let w = Number(ev.userWeightAtVote);

    // Apply per-cycle influence cap (15% max)
    if (w > 0) {
      // Use the state's current weightedTotal as the baseline for cap calculation
      // This ensures we use the actual accumulated (capped) weights, not raw event weights
      const actualWeightedTotal = Number(state.weightedTotal);

      w = await InfluenceCapService.checkAndCapUserWeight(
        tx,
        ev.userId,
        ev.brickId,
        state.currentCycleId,
        w,
        actualWeightedTotal,
        Number(ev.id) // Exclude current vote from user contribution calculation
      );
    }

    let weightedUnder =
      Number(state.weightedUnder) + (ev.voteType === "UNDER" ? w : 0);
    let weightedFair =
      Number(state.weightedFair) + (ev.voteType === "FAIR" ? w : 0);
    let weightedOver =
      Number(state.weightedOver) + (ev.voteType === "OVER" ? w : 0);
    let weightedTotal = weightedUnder + weightedFair + weightedOver;
    let weightedSinceLastMove = Number(state.weightedSinceLastMove) + w;

    const sentiment = SentimentService.calculateSentiment(
      weightedUnder,
      weightedFair,
      weightedOver
    );
    const pUnder = sentiment.p_under;
    const pFair = sentiment.p_fair;
    const pOver = sentiment.p_over;
    const pricingConfidenceC =
      ConfidenceService.calculatePricingConfidence(weightedTotal);
    const reliabilityScoreR =
      ReliabilityService.calculateReliabilityScore(weightedTotal);

    const eligible = MovementEligibilityService.isEligibleForMovement({
      weightedTotal,
      weightedSinceLastMove,
      freezeMode: state.freezeMode,
    });
    const dominant = SentimentService.getDominantDirection(pUnder, pOver);
    const dominantPct = SentimentService.getDominantPct(pUnder, pOver);
    const direction =
      dominant === "OVER" ? "UP" : dominant === "UNDER" ? "DOWN" : "NONE";

    const stateForEligibility = {
      weightedTotal,
      weightedSinceLastMove,
      freezeMode: state.freezeMode,
    };

    if (!eligible || direction === "NONE") {
      await tx.brickPriceState.update({
        where: { brickId: ev.brickId },
        data: {
          weightedUnder,
          weightedFair,
          weightedOver,
          weightedTotal,
          weightedSinceLastMove,
          pUnder,
          pFair,
          pOver,
          pricingConfidenceC,
          reliabilityScoreR,
          lastPriceUpdate: new Date(),
        },
      });
      return;
    }

    const fairLower = Number(ev.fairRangeLower);
    const fairUpper = Number(ev.fairRangeUpper);
    const anchorPrice = AnchorService.calculateAnchorPrice(
      dominant,
      fairLower,
      fairUpper
    );
    const moveSign = AnchorService.getMoveSign(dominant);
    const baseStep = ev.baseStepAtVote;

    const intensityData = IntensityService.calculateIntensityAndStep(
      pUnder,
      pOver,
      pricingConfidenceC,
      baseStep
    );
    const rawStep = intensityData.rawStep;

    const uniqueVoters = await OrderAwareService.uniqueVotersInCycle(
      tx,
      ev.brickId,
      state.currentCycleId
    );
    const catchupEnabled = await OrderAwareService.isCatchupEnabled(
      tx,
      ev.brickId,
      state.currentCycleId,
      direction,
      weightedTotal,
      uniqueVoters,
      dominantPct
    );

    const finalStep = CapService.applyCaps(
      rawStep,
      baseStep,
      anchorPrice,
      weightedTotal,
      pricingConfidenceC,
      catchupEnabled
    );

    const momentumResult = MomentumService.handleMomentum(
      Number(state.momentumScore),
      direction
    );
    const didMove = momentumResult.did_move;
    const newMomentum = momentumResult.momentum_score;

    const currentLivePrice =
      state.livePrice != null &&
      typeof state.livePrice === "object" &&
      typeof state.livePrice.toNumber === "function"
        ? state.livePrice.toNumber()
        : Number(state.livePrice);
    let newLivePrice = Number.isFinite(currentLivePrice) ? currentLivePrice : 0;
    let newWeightedSinceLastMove = weightedSinceLastMove;

    if (didMove) {
      const movedPrice = anchorPrice + moveSign * finalStep;
      newLivePrice = Number.isFinite(movedPrice)
        ? Math.max(0, movedPrice)
        : newLivePrice;
      newWeightedSinceLastMove = 0;
    }

    let updates = {
      weightedUnder,
      weightedFair,
      weightedOver,
      weightedTotal,
      weightedSinceLastMove: newWeightedSinceLastMove,
      pUnder,
      pFair,
      pOver,
      pricingConfidenceC,
      reliabilityScoreR,
      momentumScore: newMomentum,
      lastPriceUpdate: new Date(),
      livePrice: newLivePrice,
    };

    const stateAfterMove = {
      ...state,
      ...updates,
      freezeMode: state.freezeMode,
      needsRecheck: state.needsRecheck,
      freezeUntil: state.freezeUntil,
      recheckState: state.recheckState,
      recheckExpiresAt: state.recheckExpiresAt,
    };

    if (state.freezeMode && FreezeService.shouldExitFreeze(stateAfterMove)) {
      const exitReason = state.needsRecheck ? "RECHECK" : "TIMEOUT";
      await FreezeService.logFreezeExit(
        tx,
        ev.brickId,
        state.currentCycleId,
        exitReason
      );
      Object.assign(updates, FreezeService.exitFreeze());
    }

    // Check recheck resolution (ACTIVE → NONE)
    if (
      state.recheckState === "ACTIVE" &&
      RecheckService.shouldResolveRecheck(stateAfterMove, uniqueVoters)
    ) {
      Object.assign(updates, RecheckService.resolveRecheck());
    }

    // Check recheck entry (only if not already in recheck or expired)
    if (
      (!state.needsRecheck ||
        (state.recheckExpiresAt &&
          new Date() > new Date(state.recheckExpiresAt))) &&
      !state.freezeMode
    ) {
      const recheckTrigger = await RecheckService.shouldEnterRecheck(
        tx,
        stateAfterMove
      );
      if (recheckTrigger) {
        Object.assign(
          updates,
          RecheckService.enterRecheck(
            stateAfterMove,
            recheckTrigger.reason,
            recheckTrigger.state
          )
        );
      }
    }

    // Handle post-freeze refresh (Trigger D) - only if freeze is exiting now
    if (
      state.freezeMode &&
      FreezeService.shouldExitFreeze(stateAfterMove) &&
      !updates.needsRecheck
    ) {
      const postFreezeUpdates = RecheckService.enterRecheck(
        stateAfterMove,
        "POST_FREEZE",
        "ACTIVE"
      );
      Object.assign(updates, postFreezeUpdates);
    }

    if (
      !state.freezeMode &&
      !updates.needsRecheck &&
      FreezeService.shouldEnterFreeze(stateAfterMove)
    ) {
      const freezeUpdates = FreezeService.enterFreeze(stateAfterMove);
      Object.assign(updates, freezeUpdates);
      // Log freeze enter
      await FreezeService.logFreezeEnter(
        tx,
        ev.brickId,
        state.currentCycleId,
        weightedTotal
      );
    }

    const shouldReset = CycleService.shouldResetCycle(
      { ...stateAfterMove, weightedTotal, livePrice: newLivePrice },
      uniqueVoters
    );

    if (!state.freezeMode && !updates.freezeMode && shouldReset) {
      // Store old cycle info before reset
      const oldCycleId = state.currentCycleId;
      const oldCycleStartPrice = Number(state.cycleStartPrice);
      const cycleEndPrice = newLivePrice;
      const oldWeightedTotal = weightedTotal;
      const oldUniqueVoters = uniqueVoters;

      const resetUpdates = CycleService.resetCycle({
        ...stateAfterMove,
        livePrice: newLivePrice,
        weightedTotal,
      });
      // IMPORTANT: resetUpdates contains weightedTotal=0, weightedUnder=0, etc.
      // This will overwrite the accumulated weights, which is correct for cycle reset
      Object.assign(updates, resetUpdates);

      // Log cycle close event
      const outcome = CycleService.determineCycleOutcome(
        oldCycleStartPrice,
        cycleEndPrice
      );
      await tx.pricingCycleCloseEvent.create({
        data: {
          brickId: ev.brickId,
          cycleId: oldCycleId,
          closedAt: new Date(),
          cycleStartPrice: oldCycleStartPrice,
          cycleEndPrice: cycleEndPrice,
          outcome: outcome,
          uniqueVoters: oldUniqueVoters,
          weightedTotalAtClose: oldWeightedTotal,
        },
      });
    }

    // Ensure livePrice is always set (required by schema); Prisma Decimal field needs Prisma.Decimal
    const safeLivePrice = Number.isFinite(newLivePrice)
      ? newLivePrice
      : currentLivePrice;
    updates.livePrice = new Prisma.Decimal(safeLivePrice);

    await tx.brickPriceState.update({
      where: { brickId: ev.brickId },
      data: updates,
    });
  });
}

async function main() {
  const cursor = await getCursor();
  const events = await prisma.voteEvent.findMany({
    where: { id: { gt: cursor } },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  if (events.length === 0) {
    console.log("No vote events to process.");
    return;
  }
  let processed = 0;
  let skipped = 0;
  const testBrickId = "11111111-1111-4111-8111-111111111101";

  for (const ev of events) {
    try {
      await processEvent(ev);
      processed++;
    } catch (e) {
      console.error("Error event", ev.id, e.message);
    }
    await updateCursor(Number(ev.id));
  }
  console.log("Processed", processed, "vote events.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
