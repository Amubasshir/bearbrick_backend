/**
 * Worker: vote_intents -> vote_events (spec Appendix B - Vote Enricher)
 * Run: node src/scripts/enrich-votes.js
 */
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const pricing = require("../../config/pricing");
const VoteCreditService = require("../services/VoteCreditService");
const FairRangeService = require("../services/pricing/FairRangeService");
const PricingTierService = require("../services/pricing/PricingTierService");
const UserWeightService = require("../services/pricing/UserWeightService");
const prisma = require("../lib/prisma");
const BATCH = 500;
const BASE_XP_VOTE = 10;

async function getCursor() {
  const c = await prisma.workerCursor.upsert({
    where: { workerName: "vote_enricher" },
    update: {},
    create: { workerName: "vote_enricher", lastProcessedId: 0 },
  });
  return Number(c.lastProcessedId);
}

async function updateCursor(id) {
  await prisma.workerCursor.upsert({
    where: { workerName: "vote_enricher" },
    update: { lastProcessedId: id },
    create: { workerName: "vote_enricher", lastProcessedId: id },
  });
}

async function getBaselinePrice(tx, brickId) {
  const last = await tx.brickPriceHistory.findFirst({
    where: { brickId },
    orderBy: { date: "desc" },
  });
  return last ? Number(last.closePrice) : 0;
}

async function processIntent(tx, intent) {
  const user = intent.user;
  if (!user) throw new Error("User not found");

  let identity = await tx.userIdentityState.findUnique({
    where: { userId: user.id },
  });
  if (!identity) {
    identity = await tx.userIdentityState.create({
      data: {
        userId: user.id,
        emailVerified: user.email_verified_at != null,
        trustTier: 0,
        behaviorState: "NORMAL",
      },
    });
  }
  const isVerified = identity.emailVerified;

  let state = await tx.brickPriceState.findFirst({
    where: { brickId: intent.brickId },
  });
  if (!state) {
    const newCycleId = uuidv4();
    const baselinePrice = await getBaselinePrice(tx, intent.brickId);
    const initialLive = baselinePrice;
    state = await tx.brickPriceState.create({
      data: {
        brickId: intent.brickId,
        baselinePrice: initialLive,
        livePrice: initialLive,
        currentCycleId: newCycleId,
        cycleStartPrice: initialLive,
        cycleStartedAt: new Date(),
      },
    });
  }

  const livePriceAtVote = Number(state.livePrice);
  const cycleId = state.currentCycleId;

  const fairRange = FairRangeService.calculateFairRange(livePriceAtVote);
  const fairLower = fairRange.lower;
  const fairUpper = fairRange.upper;
  const baseStep = PricingTierService.getBaseStep(livePriceAtVote);
  const userWeight = isVerified
    ? await UserWeightService.computeWeight(prisma, user, identity)
    : 0;

  if (isVerified) {
    // Get full state with recheck fields for credit regain check
    const fullState = await tx.brickPriceState.findUnique({
      where: { brickId: intent.brickId },
      select: {
        livePrice: true,
        needsRecheck: true,
        recheckState: true,
        currentCycleId: true,
        recheckExpiresAt: true,
      },
    });
    await VoteCreditService.checkCreditRegain(
      tx,
      user.id,
      intent.brickId,
      fullState || state
    );
  }

  const credits = await VoteCreditService.getCredits(
    tx,
    intent.userId,
    intent.brickId
  );
  if (isVerified && !VoteCreditService.hasCredits(credits)) {
    await tx.voteIntent.update({
      where: { id: intent.id },
      data: {
        status: "REJECTED",
        processedAt: new Date(),
        rejectReason: "NO_CREDITS",
      },
    });
    throw new Error("No credits available");
  }

  if (isVerified) {
    await VoteCreditService.consumeCredit(
      tx,
      intent.userId,
      intent.brickId,
      livePriceAtVote,
      cycleId
    );
  }

  const voteEvent = await tx.voteEvent.create({
    data: {
      userId: intent.userId,
      brickId: intent.brickId,
      voteType: intent.voteType,
      livePriceAtVote,
      fairRangeLower: fairLower,
      fairRangeUpper: fairUpper,
      baseStepAtVote: baseStep,
      userWeightAtVote: userWeight,
      cycleId,
      ipHash: intent.ipHash,
      userAgent: intent.userAgent,
      sessionId: intent.sessionId,
      voteIntentId: intent.id,
    },
  });

  if (isVerified) {
    // Check if brick needs recheck for XP bonus
    const brickState = await tx.brickPriceState.findUnique({
      where: { brickId: intent.brickId },
      select: { needsRecheck: true, recheckState: true },
    });

    let xpAmount = BASE_XP_VOTE;
    let xpReason = "VOTE";

    if (brickState && brickState.needsRecheck) {
      xpAmount = Math.floor(BASE_XP_VOTE * pricing.recheck_xp_multiplier);
      xpReason = "RECHECK";
    }

    await tx.xpEvent.create({
      data: {
        userId: intent.userId,
        voteEventId: voteEvent.id,
        brickId: intent.brickId,
        xpAmount: xpAmount,
        reason: xpReason,
      },
    });
  }

  await tx.voteIntent.update({
    where: { id: intent.id },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      voteEventId: voteEvent.id,
    },
  });
}

async function main() {
  const cursor = await getCursor();
  const intents = await prisma.voteIntent.findMany({
    where: {
      status: "PENDING",
      ...(cursor > 0 ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: BATCH,
    include: { user: true },
  });
  if (intents.length === 0) {
    console.log("No pending vote intents to process.");
    return;
  }
  let processed = 0;
  for (const intent of intents) {
    try {
      await prisma.$transaction(async (tx) => {
        await processIntent(tx, intent);
      });
      processed++;
    } catch (e) {
      console.error("Error intent", intent.id, e.message);
      await prisma.voteIntent.update({
        where: { id: intent.id },
        data: {
          status: "REJECTED",
          processedAt: new Date(),
          rejectReason: e.message,
        },
      });
    }
    await updateCursor(Number(intent.id));
  }
  console.log("Processed", processed, "vote intents.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
