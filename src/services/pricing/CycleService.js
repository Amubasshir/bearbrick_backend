const { v4: uuidv4 } = require("uuid");
const pricing = require("../../../config/pricing");
const MomentumService = require("./MomentumService");

/**
 * Cycle reset: ≥7% move from cycle start AND (weighted_total >= 20 OR unique_voters >= 15). Spec §21.
 */
function shouldResetCycle(state, uniqueVoters) {
  const cycleStartPrice = Number(state.cycleStartPrice);
  if (cycleStartPrice === 0) return false;
  const livePrice = Number(state.livePrice);
  const pctFromCycleStart =
    Math.abs(livePrice - cycleStartPrice) / cycleStartPrice;
  const cycleResetPct = pricing.cycle_reset_move_pct;
  const minWeighted = pricing.cycle_reset_min_weighted;
  const minUnique = pricing.cycle_reset_min_unique;
  const wt = Number(state.weightedTotal);
  return (
    pctFromCycleStart >= cycleResetPct &&
    (wt >= minWeighted || uniqueVoters >= minUnique)
  );
}

function determineCycleOutcome(startPrice, endPrice) {
  const start = Number(startPrice);
  const end = Number(endPrice);
  if (start === 0) return "FLAT";
  const diff = end - start;
  const threshold = start * 0.001; // 0.1% threshold for FLAT
  if (Math.abs(diff) < threshold) return "FLAT";
  return diff > 0 ? "UP" : "DOWN";
}

function resetCycle(state) {
  const n = pricing.n_full_confidence;
  const wt = Number(state.weightedTotal);
  const updates = {
    currentCycleId: uuidv4(),
    cycleStartedAt: new Date(),
    cycleStartPrice: state.livePrice,
    weightedUnder: 0,
    weightedFair: 0,
    weightedOver: 0,
    weightedTotal: 0,
    weightedSinceLastMove: 0,
    pUnder: 0,
    pFair: 0,
    pOver: 0,
    pricingConfidenceC: 0,
    reliabilityScoreR: 0,
    momentumScore: MomentumService.decayMomentum(Number(state.momentumScore)),
  };
  if (wt >= n) {
    updates.lastHighConfidencePrice = state.livePrice;
    updates.lastHighConfidenceVotes = wt;
    updates.lastConfidenceTimestamp = new Date();
  }
  return updates;
}

module.exports = { shouldResetCycle, resetCycle, determineCycleOutcome };
