'use strict';

// perfect-day-worker — polls two streams in lockstep and calls
// PerfectDayService.maybeAward for each (user_id, local_day_key) seen.
//
// Streams:
//   1. session_completion_events  (written by M3b session-progress-worker)
//   2. challenge_completion_events (written by M3c challenge-progress-worker)
//
// Each stream has its own cursor in worker_cursors. We never modify M3b's
// data; we just consume it append-only.
//
// Per Q3: evaluation is event-driven and idempotent; the service handles
// dedupe via perfect_day_events UNIQUE and xp_events idempotency_key.

const prisma = require('../lib/prisma');
const { maybeAward } = require('../services/challenges/PerfectDayService');
const { toDayKeyString } = require('../lib/sessions');

const SESSION_CURSOR = 'perfect-day-worker:session_completion';
const CHALLENGE_CURSOR = 'perfect-day-worker:challenge_completion';

async function getCursor(prismaClient, name) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT last_processed_id FROM worker_cursors WHERE worker_name = $1`,
    name
  );
  if (rows.length === 0) {
    await prismaClient.$queryRawUnsafe(
      `INSERT INTO worker_cursors (worker_name, last_processed_id, "updatedAt")
       VALUES ($1, 0, NOW()) ON CONFLICT (worker_name) DO NOTHING`,
      name
    );
    return BigInt(0);
  }
  return BigInt(rows[0].last_processed_id);
}

async function setCursor(prismaClient, name, lastId) {
  await prismaClient.$queryRawUnsafe(
    `UPDATE worker_cursors SET last_processed_id = $2, "updatedAt" = NOW()
      WHERE worker_name = $1`,
    name, BigInt(lastId)
  );
}

async function processSessionStream(prismaClient, limit) {
  let cursor = await getCursor(prismaClient, SESSION_CURSOR);
  while (true) {
    const events = await prismaClient.$queryRawUnsafe(
      `SELECT id, user_id, local_day_key
         FROM session_completion_events
        WHERE id > $1
        ORDER BY created_at ASC, id ASC
        LIMIT ${limit}`,
      cursor
    );
    if (events.length === 0) break;
    for (const ev of events) {
      const userIdBig = BigInt(ev.user_id);
      const dayIso = toDayKeyString(ev.local_day_key);
      await prismaClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, userIdBig);
        await maybeAward(tx, userIdBig, dayIso);
      });
      cursor = BigInt(ev.id);
      await setCursor(prismaClient, SESSION_CURSOR, cursor);
    }
    if (events.length < limit) break;
  }
}

async function processChallengeStream(prismaClient, limit) {
  let cursor = await getCursor(prismaClient, CHALLENGE_CURSOR);
  while (true) {
    // We need the local_day_key — challenge_completion_events doesn't store
    // it, so join through user_challenge_assignments.assignment_date for
    // daily-scope completions. Weekly completions don't trigger Perfect Day.
    const events = await prismaClient.$queryRawUnsafe(
      `SELECT cce.id, cce.user_id, uca.assignment_date AS local_day_key
         FROM challenge_completion_events cce
         JOIN user_challenge_assignments uca ON uca.id = cce.challenge_assignment_id
        WHERE cce.id > $1 AND uca.scope = 'daily' AND uca.assignment_date IS NOT NULL
        ORDER BY cce.created_at ASC, cce.id ASC
        LIMIT ${limit}`,
      cursor
    );
    if (events.length === 0) break;
    for (const ev of events) {
      const userIdBig = BigInt(ev.user_id);
      const dayIso = toDayKeyString(ev.local_day_key);
      await prismaClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, userIdBig);
        await maybeAward(tx, userIdBig, dayIso);
      });
      cursor = BigInt(ev.id);
      await setCursor(prismaClient, CHALLENGE_CURSOR, cursor);
    }
    if (events.length < limit) break;
  }
}

async function processBoth(prismaClient = prisma, options = {}) {
  const limit = options.limit ?? 200;
  await processSessionStream(prismaClient, limit);
  await processChallengeStream(prismaClient, limit);
}

async function runWorkerLoop() {
  console.log('[perfect-day-worker] starting');
  const POLL_INTERVAL_MS = 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processBoth(prisma);
    } catch (err) {
      console.error('[perfect-day-worker] batch error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = {
  processBoth,
  processSessionStream,
  processChallengeStream,
};

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[perfect-day-worker] fatal:', err);
    process.exit(1);
  });
}
