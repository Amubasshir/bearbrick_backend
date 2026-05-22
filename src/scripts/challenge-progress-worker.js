'use strict';

// challenge-progress-worker — polls vote_events via its own cursor and
// advances challenge progress for the voting user.
// Mirrors session-progress-worker structure: cursor-based, per-user advisory
// lock per transaction, batch poll loop.

const prisma = require('../lib/prisma');
const {
  processOneVoteForChallenges,
} = require('../services/challenges/ChallengeProgressService');

const WORKER_NAME = 'challenge-progress-worker';

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

async function processVoteEvents(prismaClient = prisma, options = {}) {
  const limit = options.limit ?? 200;
  let cursor = await getCursor(prismaClient);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const events = await prismaClient.$queryRawUnsafe(
      `SELECT ve.id, ve.user_id, ve.brick_id, ve.vote_type, ve."createdAt" AS created_at
         FROM vote_events ve
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
        await processOneVoteForChallenges(tx, ev);
      });
      cursor = BigInt(ev.id);
      await setCursor(prismaClient, cursor);
    }
    if (events.length < limit) break;
  }
}

async function runWorkerLoop() {
  console.log('[challenge-progress-worker] starting');
  const POLL_INTERVAL_MS = 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processVoteEvents(prisma);
    } catch (err) {
      console.error('[challenge-progress-worker] batch error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { processVoteEvents, processOneVoteForChallenges };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[challenge-progress-worker] fatal:', err);
    process.exit(1);
  });
}
