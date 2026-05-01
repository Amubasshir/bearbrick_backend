/**
 * OVER → anchor = upper_range, move up. UNDER → anchor = lower_range, move down. Spec §15.
 */
function calculateAnchorPrice(dominant, lowerRange, upperRange) {
  if (dominant === "OVER") return upperRange;
  if (dominant === "UNDER") return lowerRange;
  return (lowerRange + upperRange) / 2;
}

function getMoveSign(dominant) {
  if (dominant === "OVER") return 1;
  if (dominant === "UNDER") return -1;
  return 0;
}

module.exports = { calculateAnchorPrice, getMoveSign };
