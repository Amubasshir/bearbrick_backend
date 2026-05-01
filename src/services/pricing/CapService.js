const pricing = require("../../../config/pricing");

/**
 * Apply caps in order: raw_step → early cap → dynamic cap → catch-up cap → clamp ≥ base_step. Spec §16–18.
 */
function applyCaps(
  rawStep,
  baseStep,
  anchorPrice,
  weightedTotal,
  pricingConfidenceC,
  catchupEnabled = false,
) {
  let step = rawStep;
  const earlyRampLimit = pricing.early_ramp_weighted_limit;
  const earlyRampMaxMult = pricing.early_ramp_max_mult;

  if (weightedTotal < earlyRampLimit) {
    const earlyCapMult = Math.min(
      earlyRampMaxMult,
      1 + 0.5 * (weightedTotal / earlyRampLimit),
    );
    const earlyCap = baseStep * earlyCapMult;
    step = Math.min(step, earlyCap);
  }

  const capParams = getCapParamsForTier(baseStep);
  const capPct =
    capParams.cap_min +
    (capParams.cap_max - capParams.cap_min) * pricingConfidenceC;
  const dynamicCap = Math.min(
    capPct * anchorPrice,
    pricing.absolute_cap_dollars,
  );
  step = Math.min(step, dynamicCap);

  if (catchupEnabled) {
    const catchupCap = Math.min(
      pricing.catchup_max_pct * anchorPrice,
      pricing.absolute_cap_dollars,
    );
    step = Math.min(step, catchupCap);
  }

  step = Math.max(baseStep, step);
  return Math.round(step);
}

function getCapParamsForTier(baseStep) {
  const capConfig = pricing.cap_params || {};
  const defaults = capConfig.default || { cap_min: 0.02, cap_max: 0.1 };
  const tiers = capConfig.tiers || {};
  if (baseStep <= 7) return tiers.low || defaults;
  if (baseStep <= 25) return tiers.mid || defaults;
  return tiers.high || defaults;
}

module.exports = { applyCaps };
