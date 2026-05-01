const pricing = require("../../../config/pricing");

/**
 * Pricing confidence C = min(1.0, weighted_total / N). Spec §11.
 */
function calculatePricingConfidence(weightedTotal) {
  const n = pricing.n_full_confidence;
  return Math.min(1, weightedTotal / n);
}

module.exports = { calculatePricingConfidence };
