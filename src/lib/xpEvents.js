'use strict';

// Shared XP event minting helper. Extracted from M3b session-progress-worker.js
// so M3c workers (challenge-progress, perfect-day) can use the same code path
// without modifying the M3b worker. After M3c lands, a cleanup commit can
// switch session-progress-worker to import from here — out of scope for now.
//
// Flow per event:
//   1. INSERT INTO xp_idempotency_keys (...) ON CONFLICT DO NOTHING
//      → if no row returned, the key is already claimed; skip insert, return null.
//   2. INSERT INTO xp_events (...) RETURNING id
//   3. UPDATE xp_idempotency_keys SET xp_event_id = <id> WHERE key = <key>
//      (traceability backfill)
//
// All three statements run inside the caller's transaction (`tx`). Caller is
// responsible for the per-user advisory lock and overall transaction scope.

const REQUIRED_FIELDS = [
  'userId',
  'xpAmount',
  'reason',
  'eventType',
  'sourceSystem',
  'localDayKey',
  'idempotencyKey',
];

function validateOpts(opts) {
  for (const f of REQUIRED_FIELDS) {
    if (opts[f] === undefined || opts[f] === null) {
      throw new Error(`insertXpEvent: missing required field "${f}"`);
    }
  }
}

/**
 * Build the three SQL+params calls that an insertXpEvent invocation would make,
 * without actually running them. Used for unit testing the shape and order of
 * the calls. The third call's `params` is a 1-element array (key); the actual
 * xp_event_id is appended at run time by `insertXpEvent`.
 */
function buildInsertXpEventCalls(opts) {
  validateOpts(opts);
  const voteEventId = opts.voteEventId === undefined ? null : opts.voteEventId;

  return [
    {
      sql:
        `INSERT INTO xp_idempotency_keys (key, user_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
      params: [opts.idempotencyKey, opts.userId],
    },
    {
      sql:
        `INSERT INTO xp_events
           (user_id, vote_event_id, xp_amount, xp_delta_signed, reason, event_type,
            source_system, xp_confirmed, local_day_key, idempotency_key, "createdAt")
         VALUES ($1, $2, $3, $3, $4::"XpReason", $5, $6, TRUE, $7::date, $8, NOW())
         RETURNING id`,
      params: [
        opts.userId,
        voteEventId,
        opts.xpAmount,
        opts.reason,
        opts.eventType,
        opts.sourceSystem,
        opts.localDayKey,
        opts.idempotencyKey,
      ],
    },
    {
      sql: `UPDATE xp_idempotency_keys SET xp_event_id = $2 WHERE key = $1`,
      params: [opts.idempotencyKey],
    },
  ];
}

/**
 * Claim the idempotency key, insert the xp_event, backfill the key with the
 * event id. Returns the inserted BigInt id, or null if the key was already
 * claimed (i.e. duplicate suppressed).
 */
async function insertXpEvent(tx, opts) {
  const [claimCall, insertCall, backfillCall] = buildInsertXpEventCalls(opts);

  const claim = await tx.$queryRawUnsafe(claimCall.sql, ...claimCall.params);
  if (!claim || claim.length === 0) return null;

  const inserted = await tx.$queryRawUnsafe(insertCall.sql, ...insertCall.params);
  const newId = inserted[0]?.id != null ? BigInt(inserted[0].id) : null;

  await tx.$queryRawUnsafe(backfillCall.sql, ...backfillCall.params, newId);

  return newId;
}

module.exports = {
  insertXpEvent,
  buildInsertXpEventCalls,
};
