const pricing = require("../../../config/pricing");

/**
 * Fair range ±5% from live price. Spec §7.
 */
function calculateFairRange(livePrice) {
  const pct = pricing.fair_range_pct;
  const lower = Math.round(livePrice * (1 - pct) * 100) / 100;
  const upper = Math.round(livePrice * (1 + pct) * 100) / 100;
  return { lower, upper };
}

module.exports = { calculateFairRange };
