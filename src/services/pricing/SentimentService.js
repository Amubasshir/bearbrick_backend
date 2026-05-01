/**
 * Sentiment from weighted counters. Spec §10.
 */
function calculateSentiment(weightedUnder, weightedFair, weightedOver) {
  const weightedTotal = weightedUnder + weightedFair + weightedOver;
  if (weightedTotal === 0) {
    return { p_under: 0, p_fair: 0, p_over: 0 };
  }
  return {
    p_under: weightedUnder / weightedTotal,
    p_fair: weightedFair / weightedTotal,
    p_over: weightedOver / weightedTotal,
  };
}

function getDominantDirection(pUnder, pOver) {
  if (pOver > pUnder) return "OVER";
  if (pUnder > pOver) return "UNDER";
  return null;
}

function getDominantPct(pUnder, pOver) {
  return Math.max(pUnder, pOver);
}

module.exports = {
  calculateSentiment,
  getDominantDirection,
  getDominantPct,
};
