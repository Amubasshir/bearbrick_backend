const pricing = require("../../../config/pricing");

/**
 * Reliability score R (v1.0: volume_score only). Spec §12.
 */
function calculateReliabilityScore(weightedTotal) {
  const n = pricing.n_full_confidence;
  return Math.min(1, weightedTotal / n);
}

module.exports = { calculateReliabilityScore };
