const FreezeService = require("./FreezeService");
const pricing = require("../../../config/pricing");

/**
 * Check if trigger A (Stale High-Confidence) should fire.
 */
function triggerA_StaleConfidence(state) {
  if (state.recheckState === "ACTIVE") return false;
  if (!state.lastConfidenceTimestamp) return true; // Never had confidence
  const days =
    (Date.now() - new Date(state.lastConfidenceTimestamp)) /
    (24 * 60 * 60 * 1000);
  return days >= pricing.recheck_stale_days;
}

/**
 * Check if trigger B (Low sample / weak cycle) should fire.
 */
async function triggerB_LowSample(prisma, state) {
  if (state.freezeMode) return false;
  const cycleAgeDays =
    (Date.now() - new Date(state.cycleStartedAt)) / (24 * 60 * 60 * 1000);
  if (
    cycleAgeDays > pricing.recheck_low_sample_days &&
    Number(state.weightedTotal) < pricing.recheck_min_healthy_weighted
  ) {
    return true;
  }
  return false;
}

/**
 * Check if trigger C (Opposing signal) should fire.
 */
function triggerC_OpposingSignal(state) {
  const dominantPct = Math.max(Number(state.pUnder), Number(state.pOver));
  const pricingConfidenceC = Number(state.pricingConfidenceC);
  const momentumScore = Number(state.momentumScore);

  if (dominantPct >= 0.65 && pricingConfidenceC < 0.4 && momentumScore !== 0) {
    // Check if dominant direction opposes momentum
    const isOverDominant = Number(state.pOver) > Number(state.pUnder);
    const momentumPositive = momentumScore > 0;
    if (isOverDominant !== momentumPositive) {
      return true; // Opposing signal
    }
  }
  return false;
}

/**
 * Check if trigger D (Post-freeze refresh) should fire.
 * Called when freeze_mode transitions true → false.
 */
function triggerD_PostFreeze(state) {
  // This is handled in aggregate-prices.js when freeze exits
  return false; // Not used here, handled elsewhere
}

/**
 * Enhanced shouldEnterRecheck with all triggers.
 * Returns reason if should enter, null otherwise.
 */
async function shouldEnterRecheck(prisma, state) {
  // Trigger A: Stale confidence
  if (triggerA_StaleConfidence(state)) {
    return { reason: "STALE", state: "WATCH" };
  }

  // Trigger B: Low sample
  if (await triggerB_LowSample(prisma, state)) {
    return { reason: "LOW_SAMPLE", state: "WATCH" };
  }

  // Trigger C: Opposing signal
  if (triggerC_OpposingSignal(state)) {
    return { reason: "OPPOSING_SIGNAL", state: "WATCH" };
  }

  return null;
}

/**
 * Enter recheck with state machine support.
 */
function enterRecheck(state, reason, targetState = "WATCH") {
  const now = new Date();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + pricing.recheck_window_days);

  const updates = {
    needsRecheck: true,
    recheckState: targetState,
    recheckReason: reason,
    recheckStartedAt: now,
    recheckExpiresAt: expiresAt,
  };

  if (state.freezeMode && targetState === "ACTIVE") {
    Object.assign(updates, FreezeService.exitFreeze());
  }

  return updates;
}

/**
 * Check if recheck should resolve (ACTIVE → NONE).
 */
function shouldResolveRecheck(state, uniqueVoters) {
  if (state.recheckState !== "ACTIVE") return false;

  const weightedTotal = Number(state.weightedTotal);
  const pricingConfidenceC = Number(state.pricingConfidenceC);

  return (
    uniqueVoters >= pricing.catchup_min_unique_voters &&
    weightedTotal >= pricing.catchup_min_weighted_total &&
    (pricingConfidenceC >= 0.5 || weightedTotal >= 25)
  );
}

/**
 * Resolve recheck (ACTIVE → NONE).
 */
function resolveRecheck() {
  return {
    needsRecheck: false,
    recheckState: "NONE",
    recheckReason: null,
    recheckStartedAt: null,
    recheckExpiresAt: null,
  };
}

/**
 * Check if ACTIVE should downgrade to WATCH (TTL expiry).
 */
function shouldDowngradeActive(state) {
  if (state.recheckState !== "ACTIVE") return false;
  if (!state.recheckExpiresAt) return false;
  return new Date() > new Date(state.recheckExpiresAt);
}

/**
 * Downgrade ACTIVE to WATCH.
 */
function downgradeActive() {
  return {
    recheckState: "WATCH",
    recheckExpiresAt: null,
  };
}

module.exports = {
  shouldEnterRecheck,
  enterRecheck,
  shouldResolveRecheck,
  resolveRecheck,
  shouldDowngradeActive,
  downgradeActive,
  triggerA_StaleConfidence,
  triggerB_LowSample,
  triggerC_OpposingSignal,
};
