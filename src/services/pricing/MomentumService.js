const pricing = require("../../../config/pricing");

/**
 * Opposite direction consumes momentum first; then update momentum. Spec §19.
 */
function handleMomentum(currentMomentum, direction) {
  const moveSign = direction === "UP" ? 1 : -1;
  let didMove = true;
  let newMomentum = currentMomentum;

  if (moveSign === 1 && currentMomentum < 0) {
    newMomentum = currentMomentum + 1;
    didMove = false;
  } else if (moveSign === -1 && currentMomentum > 0) {
    newMomentum = currentMomentum - 1;
    didMove = false;
  }

  if (didMove) {
    newMomentum = currentMomentum + moveSign;
  }

  const minM = pricing.momentum_clamp_min;
  const maxM = pricing.momentum_clamp_max;
  newMomentum = Math.max(minM, Math.min(maxM, newMomentum));

  return { did_move: didMove, momentum_score: newMomentum };
}

function decayMomentum(currentMomentum) {
  if (currentMomentum === 0) return 0;
  const decayed = currentMomentum - (currentMomentum > 0 ? 1 : -1);
  const minM = pricing.momentum_clamp_min;
  const maxM = pricing.momentum_clamp_max;
  return Math.max(minM, Math.min(maxM, decayed));
}

module.exports = { handleMomentum, decayMomentum };
