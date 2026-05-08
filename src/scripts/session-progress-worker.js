'use strict';

const prisma = require('../lib/prisma');
const { computeLocalDayKey, resolveSessionWindow, toDayKeyString } = require('../lib/sessions');
const ActiveVoteService = require('../services/sessions/ActiveVoteService');
const StreakService = require('../services/sessions/StreakService');

const TARGETS = { MORNING: 7, EVENING: 11 };
const WORKER_NAME = 'session-progress-worker';

// XP amounts for completion + streak bonus. Read from active xp_config_versions
// at startup so values stay deterministic per row but configurable via DB.
async function loadXpConfig(prismaClient) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions WHERE is_active = TRUE ORDER BY version DESC LIMIT 1`
  );
  const cfg = rows[0]?.config?.xpAmounts || {};
  return {
    morningCompletionXp: cfg.session_completion_morning ?? 50,
    eveningCompletionXp: cfg.session_completion_evening ?? 75,
    streakBonusXp: cfg.streak_bonus ?? 5,
  };
}

// ---------------------------------------------------------------------------
// Single-vote handler (called inside per-user advisory-locked transaction)
// ---------------------------------------------------------------------------

async function processOneVote(tx, voteRow, xpConfig) {
  const userIdBig = BigInt(voteRow.user_id);
  const tz = voteRow.timezone || 'UTC';
  const createdAt = voteRow.created_at instanceof Date
    ? voteRow.created_at
    : new Date(voteRow.created_at);

  // 1. Always UPSERT active_votes
  await ActiveVoteService.recordVote(tx, {
    id: voteRow.id,
    user_id: voteRow.user_id,
    brick_id: voteRow.brick_id,
    vote_type: voteRow.vote_type,
    created_at: createdAt,
  });

  // 2. Window + local day
  const window = resolveSessionWindow(createdAt, tz);
  if (!window) return; // dead window — no progress

  const localDayKey = computeLocalDayKey(createdAt, tz);
  const dayIso = toDayKeyString(localDayKey);

  // 3. Look up the matching session set for the day. We do NOT JIT-build here —
  // the builder worker / read endpoint owns set creation. If no set exists,
  // skip session credit (active_votes already updated).
  const setRows = await tx.$queryRawUnsafe(
    `SELECT id FROM daily_session_sets
      WHERE local_day_key = $1::date AND kind = $2::"SessionKind"`,
    dayIso, window
  );
  if (setRows.length === 0) return;
  const sessionSetId = setRows[0].id;

  // 4. Is this brick in that set?
  const memberRows = await tx.$queryRawUnsafe(
    `SELECT 1 FROM daily_session_set_items
      WHERE session_set_id = $1::uuid AND brick_id = $2`,
    sessionSetId, voteRow.brick_id
  );
  if (memberRows.length === 0) return;

  // 5. Insert into user_session_brick_counts (double-count guard)
  const insertedCount = await tx.$queryRawUnsafe(
    `INSERT INTO user_session_brick_counts
       (user_id, session_set_id, brick_id, vote_event_id)
     VALUES ($1, $2::uuid, $3, $4)
     ON CONFLICT (user_id, session_set_id, brick_id) DO NOTHING
     RETURNING id`,
    userIdBig, sessionSetId, voteRow.brick_id, BigInt(voteRow.id)
  );
  if (insertedCount.length === 0) return; // already counted — skip

  // 6. Bootstrap user_session_progress if missing, then bump partial_count
  const target = TARGETS[window];
  await tx.$queryRawUnsafe(
    `INSERT INTO user_session_progress
       (user_id, session_set_id, partial_count, target_count, created_at, updated_at)
     VALUES ($1, $2::uuid, 0, $3, NOW(), NOW())
     ON CONFLICT (user_id, session_set_id) DO NOTHING`,
    userIdBig, sessionSetId, target
  );
  const progressRows = await tx.$queryRawUnsafe(
    `UPDATE user_session_progress
        SET partial_count = partial_count + 1,
            updated_at    = NOW()
      WHERE user_id = $1 AND session_set_id = $2::uuid
      RETURNING partial_count, target_count, completed_at`,
    userIdBig, sessionSetId
  );
  const progress = progressRows[0];

  // 7. Completion?
  if (Number(progress.partial_count) >= Number(progress.target_count) && !progress.completed_at) {
    // Mark progress complete
    await tx.$queryRawUnsafe(
      `UPDATE user_session_progress
          SET completed_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND session_set_id = $2::uuid`,
      userIdBig, sessionSetId
    );

    // Apply streak FIRST so we know the resulting streak count for the event row
    const newStreak = await StreakService.applyCompletion(tx, userIdBig, window, dayIso);

    // Insert completion event (idempotent via unique on (user_id, session_set_id))
    await tx.$queryRawUnsafe(
      `INSERT INTO session_completion_events
         (user_id, session_set_id, kind, local_day_key, streak_after_completion,
          triggered_by_vote_event_id)
       VALUES ($1, $2::uuid, $3::"SessionKind", $4::date, $5, $6)
       ON CONFLICT (user_id, session_set_id) DO NOTHING`,
      userIdBig, sessionSetId, window, dayIso, newStreak, BigInt(voteRow.id)
    );

    // XP — completion bonus
    const completionAmount = window === 'MORNING'
      ? xpConfig.morningCompletionXp
      : xpConfig.eveningCompletionXp;
    const completionKey = `session_completion:${userIdBig.toString()}:${sessionSetId}`;
    await insertXpEvent(tx, {
      userId: userIdBig,
      voteEventId: BigInt(voteRow.id),
      xpAmount: completionAmount,
      reason: 'STREAK', // legacy enum stays stable; event_type carries the truth
      eventType: 'session_completion',
      idempotencyKey: completionKey,
      localDayKey: dayIso,
    });

    // XP — streak bonus
    const streakKey = `streak_bonus:${window}:${userIdBig.toString()}:${dayIso}`;
    await insertXpEvent(tx, {
      userId: userIdBig,
      voteEventId: BigInt(voteRow.id),
      xpAmount: xpConfig.streakBonusXp,
      reason: 'STREAK',
      eventType: 'streak_bonus',
      idempotencyKey: streakKey,
      localDayKey: dayIso,
    });
  }
}

async function insertXpEvent(tx, opts) {
  // xp_idempotency_keys is the cross-system idempotency guard. Insert there
  // first; if the key already exists, skip the xp_events insert entirely.
  const claim = await tx.$queryRawUnsafe(
    `INSERT INTO xp_idempotency_keys (key, user_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    opts.idempotencyKey, opts.userId
  );
  if (claim.length === 0) return;

  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO xp_events
       (user_id, vote_event_id, xp_amount, xp_delta_signed, reason, event_type,
        source_system, xp_confirmed, local_day_key, idempotency_key, "createdAt")
     VALUES ($1, $2, $3, $3, $4::"XpReason", $5, 'm3b', TRUE, $6::date, $7, NOW())
     RETURNING id`,
    opts.userId, opts.voteEventId, opts.xpAmount, opts.reason, opts.eventType,
    opts.localDayKey, opts.idempotencyKey
  );

  // Backfill xp_idempotency_keys.xp_event_id for traceability
  await tx.$queryRawUnsafe(
    `UPDATE xp_idempotency_keys SET xp_event_id = $2 WHERE key = $1`,
    opts.idempotencyKey, BigInt(inserted[0].id)
  );
}

// ---------------------------------------------------------------------------
// Cursor-based driver
// ---------------------------------------------------------------------------

async function getCursor(prismaClient) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT last_processed_id FROM worker_cursors WHERE worker_name = $1`,
    WORKER_NAME
  );
  if (rows.length === 0) {
    await prismaClient.$queryRawUnsafe(
      `INSERT INTO worker_cursors (worker_name, last_processed_id, "updatedAt")
       VALUES ($1, 0, NOW())
       ON CONFLICT (worker_name) DO NOTHING`,
      WORKER_NAME
    );
    return BigInt(0);
  }
  return BigInt(rows[0].last_processed_id);
}

async function setCursor(prismaClient, lastId) {
  await prismaClient.$queryRawUnsafe(
    `UPDATE worker_cursors SET last_processed_id = $2, "updatedAt" = NOW()
      WHERE worker_name = $1`,
    WORKER_NAME, BigInt(lastId)
  );
}

/**
 * Process all unconsumed vote_events in deterministic order, advancing the
 * worker_cursors row. Each vote is wrapped in a per-user advisory-lock txn.
 */
async function processVoteEvents(prismaClient = prisma, options = {}) {
  const limit = options.limit ?? 200;
  const xpConfig = await loadXpConfig(prismaClient);

  let cursor = await getCursor(prismaClient);
  // Loop until no more events
  // Outer batch loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const events = await prismaClient.$queryRawUnsafe(
      `SELECT ve.id, ve.user_id, ve.brick_id, ve.vote_type, ve."createdAt" AS created_at,
              u.timezone
         FROM vote_events ve
         JOIN "User" u ON u.id = ve.user_id
        WHERE ve.id > $1
        ORDER BY ve."createdAt" ASC, ve.id ASC
        LIMIT ${limit}`,
      cursor
    );
    if (events.length === 0) break;

    for (const ev of events) {
      const userIdBig = BigInt(ev.user_id);
      await prismaClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, userIdBig);
        await processOneVote(tx, ev, xpConfig);
      });
      cursor = BigInt(ev.id);
      await setCursor(prismaClient, cursor);
    }
    if (events.length < limit) break;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function runWorkerLoop() {
  console.log('[session-progress-worker] starting');
  const POLL_INTERVAL_MS = 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processVoteEvents(prisma);
    } catch (err) {
      console.error('[session-progress-worker] batch error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { processVoteEvents, processOneVote };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[session-progress-worker] fatal:', err);
    process.exit(1);
  });
}
