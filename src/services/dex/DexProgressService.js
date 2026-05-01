/**
 * DexProgressService — server-authoritative, monotonic stage progression.
 * Stage never decreases. All mutations are atomic (pass a tx from $transaction).
 * Every stage advancement is logged to DexEventLog.
 */

/**
 * Get or create UserBrickProgress within a transaction.
 * Returns the record (existing or freshly created with stage=0).
 */
async function getOrCreateProgress(tx, userId, brickId) {
  const existing = await tx.userBrickProgress.findUnique({
    where: { userId_brickId: { userId, brickId } },
  });
  if (existing) return existing;

  return tx.userBrickProgress.create({
    data: { userId, brickId, stage: 0 },
  });
}

/**
 * Advance user stage to `toStage` (only if current stage < toStage).
 * `meta` is an object of extra fields to merge in (e.g. { voteType }).
 * Logs the transition to DexEventLog when a stage advance actually occurs.
 * Returns the updated progress record.
 */
async function advanceStage(tx, userId, brickId, toStage, meta = {}) {
  const progress = await getOrCreateProgress(tx, userId, brickId);
  if (progress.stage >= toStage) return progress; // already at or past target

  const fromStage = progress.stage;
  const stageTimestampField = `stage${toStage}At`;

  const updated = await tx.userBrickProgress.update({
    where: { userId_brickId: { userId, brickId } },
    data: {
      stage: toStage,
      [stageTimestampField]: new Date(),
      ...meta,
    },
  });

  // Append-only audit log — best effort inside the same transaction
  await tx.dexEventLog.create({
    data: {
      eventType: "STAGE_ADVANCED",
      userId,
      brickId,
      fromStage,
      toStage,
      payload: { meta },
    },
  });

  return updated;
}

/**
 * Stage 1 completion criteria (spec §4.1):
 *   (dwellSeconds >= 12 AND scrollPct >= 80) OR interactionSeen
 */
function meetsStage1Criteria(dwellSeconds, scrollPct, interactionSeen) {
  return (dwellSeconds >= 12 && scrollPct >= 80) || interactionSeen === true;
}

module.exports = { getOrCreateProgress, advanceStage, meetsStage1Criteria };
