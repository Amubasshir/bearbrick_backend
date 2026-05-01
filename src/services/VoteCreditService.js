const pricing = require("../../config/pricing");

/**
 * Vote credit service - check/consume/regain credits per user×brick.
 * Matches Laravel VoteCreditService.
 */
async function getCredits(tx, userId, brickId) {
  let credits = await tx.userBrickVoteCredit.findUnique({
    where: { userId_brickId: { userId, brickId } },
  });
  if (!credits) {
    credits = await tx.userBrickVoteCredit.create({
      data: {
        userId,
        brickId,
        creditsRemaining: pricing.vote_credits_max,
      },
    });
  }
  return credits;
}

function hasCredits(credits) {
  return credits.creditsRemaining > 0;
}

/**
 * Check and handle credit regain (price moved ≥7% or brick needs_recheck).
 * Recheck credit grant: once per cycle or once per recheck window.
 */
async function checkCreditRegain(tx, userId, brickId, state) {
  const credits = await getCredits(tx, userId, brickId);
  if (credits.creditsRemaining > 0) return;

  const livePrice = Number(state.livePrice);
  const regainPct = pricing.credit_regain_move_pct;

  // Rule 1: Price moved ≥7% away from last vote price
  if (credits.lastVotePrice != null && Number(credits.lastVotePrice) > 0) {
    const lastPrice = Number(credits.lastVotePrice);
    const movePct = Math.abs(livePrice - lastPrice) / lastPrice;
    if (movePct >= regainPct) {
      const lastRegain = credits.lastCreditRegainPrice
        ? Number(credits.lastCreditRegainPrice)
        : null;
      if (
        lastRegain == null ||
        lastRegain === 0 ||
        Math.abs(livePrice - lastRegain) / lastRegain >= regainPct
      ) {
        await regainCredit(tx, userId, brickId, livePrice);
        return;
      }
    }
  }

  // Rule 2: Brick enters recheck (needs_recheck OR recheck_state == 'ACTIVE')
  if (state.needsRecheck || state.recheckState === "ACTIVE") {
    // Check if already granted in this cycle/window
    const currentCycleId = state.currentCycleId;
    const lastGrantCycle = credits.lastRecheckCreditGrantCycle;
    const lastGrantAt = credits.lastRecheckCreditGrantAt;
    const recheckExpiresAt = state.recheckExpiresAt;

    // Grant if:
    // - Never granted before, OR
    // - Granted in different cycle, OR
    // - Recheck window expired (new window)
    const shouldGrant =
      !lastGrantCycle ||
      lastGrantCycle !== currentCycleId ||
      (recheckExpiresAt &&
        lastGrantAt &&
        new Date(lastGrantAt) < new Date(recheckExpiresAt) &&
        new Date() > new Date(recheckExpiresAt));

    if (shouldGrant) {
      await regainCreditForRecheck(
        tx,
        userId,
        brickId,
        livePrice,
        currentCycleId
      );
    }
  }
}

async function regainCredit(tx, userId, brickId, currentPrice) {
  await tx.userBrickVoteCredit.update({
    where: { userId_brickId: { userId, brickId } },
    data: {
      creditsRemaining: 1,
      lastCreditRegainPrice: currentPrice,
      lastCreditRegainAt: new Date(),
    },
  });
}

async function regainCreditForRecheck(
  tx,
  userId,
  brickId,
  currentPrice,
  cycleId
) {
  await tx.userBrickVoteCredit.update({
    where: { userId_brickId: { userId, brickId } },
    data: {
      creditsRemaining: 1,
      lastCreditRegainPrice: currentPrice,
      lastCreditRegainAt: new Date(),
      lastRecheckCreditGrantCycle: cycleId,
      lastRecheckCreditGrantAt: new Date(),
    },
  });
}

async function consumeCredit(tx, userId, brickId, livePriceAtVote, cycleId) {
  const credits = await getCredits(tx, userId, brickId);
  if (credits.creditsRemaining <= 0) throw new Error("No credits available");
  await tx.userBrickVoteCredit.update({
    where: { userId_brickId: { userId, brickId } },
    data: {
      creditsRemaining: credits.creditsRemaining - 1,
      lastVotePrice: livePriceAtVote,
      lastVoteCycleId: cycleId,
      lastVoteAt: new Date(),
    },
  });
}

module.exports = {
  getCredits,
  hasCredits,
  checkCreditRegain,
  consumeCredit,
};
