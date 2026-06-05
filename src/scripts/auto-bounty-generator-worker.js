'use strict';

// auto-bounty-generator-worker — daily scan over PUBLISHED bricks (spec §5).
// For every brick:
//   - generate an OPEN bounty for each active definition whose target field is
//     still null (idempotent via the unique_open_bounty partial index), and
//   - close any OPEN bounty whose target field is now filled (Q13 — covers
//     direct admin edits as well as Approve+Apply).
//
// PUBLISHED is the established "active eligible" brick filter (mirrors
// SessionSetService). Both operations delegate to BountyInstanceService so the
// generation/closure rules live in exactly one place. Fully idempotent: a
// re-run, restart, or overlap creates and closes nothing twice.

const prisma = require('../lib/prisma');
const Inst = require('../services/bounties/BountyInstanceService');

/**
 * Run one scan. `options.brickIds` (string[]) scopes the scan to specific
 * bricks (used by tests); otherwise every PUBLISHED brick is scanned.
 * Returns { scanned, created, closed }.
 */
async function processOneTick(prismaClient = prisma, options = {}) {
  const c = prismaClient;
  const scoped = Array.isArray(options.brickIds) && options.brickIds.length > 0;
  const bricks = scoped
    ? await c.$queryRawUnsafe(
      `SELECT ${Inst.BRICK_SELECT} FROM bricks WHERE status = 'PUBLISHED' AND id = ANY($1::text[])`,
      options.brickIds
    )
    : await c.$queryRawUnsafe(
      `SELECT ${Inst.BRICK_SELECT} FROM bricks WHERE status = 'PUBLISHED'`
    );

  let created = 0;
  let closed = 0;
  for (const brick of bricks) {
    // eslint-disable-next-line no-await-in-loop
    created += await Inst.generateForBrick(c, brick);
    // eslint-disable-next-line no-await-in-loop
    closed += await Inst.closeFilledForBrick(c, brick);
  }
  return { scanned: bricks.length, created, closed };
}

async function runWorkerLoop() {
  console.log('[auto-bounty-generator-worker] starting');
  const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await processOneTick(prisma);
      console.log(`[auto-bounty-generator-worker] scanned=${r.scanned} created=${r.created} closed=${r.closed}`);
    } catch (err) {
      console.error('[auto-bounty-generator-worker] tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { processOneTick };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[auto-bounty-generator-worker] fatal:', err);
    process.exit(1);
  });
}
