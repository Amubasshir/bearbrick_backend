/**
 * intensity = max(p_under, p_over) * C; multiplier = 1 + 2*intensity; raw_step = base_step * multiplier. Spec §16.
 */
function calculateIntensityAndStep(
  pUnder,
  pOver,
  pricingConfidenceC,
  baseStep,
) {
  const dominantPct = Math.max(pUnder, pOver);
  const intensity = dominantPct * pricingConfidenceC;
  const multiplier = 1 + 2 * intensity;
  const rawStep = baseStep * multiplier;
  return { intensity, multiplier, rawStep };
}

module.exports = { calculateIntensityAndStep };
