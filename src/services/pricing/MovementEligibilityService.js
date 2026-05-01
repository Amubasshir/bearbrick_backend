const pricing = require("../../../config/pricing");

/**
 * Price may move only if ALL: weighted_total >= 5, weighted_since_last_move >= 5, !freeze_mode. Spec §14.
 */
function isEligibleForMovement(state) {
  const minWeighted = pricing.min_weighted_total_for_move;
  const moveBatch = pricing.move_batch_size_weighted;
  const wt = Number(state.weightedTotal);
  const wslm = Number(state.weightedSinceLastMove);
  return wt >= minWeighted && wslm >= moveBatch && !state.freezeMode;
}

module.exports = { isEligibleForMovement };
