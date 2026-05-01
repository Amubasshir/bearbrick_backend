const pricing = require("../../../config/pricing");

/**
 * base_step for price from price_tiers. Spec §8.
 */
function getBaseStep(price) {
  const tiers = pricing.price_tiers;
  for (const t of tiers) {
    if (price >= t.min && price <= t.max) return t.base_step;
  }
  return tiers[tiers.length - 1].base_step;
}

module.exports = { getBaseStep };
