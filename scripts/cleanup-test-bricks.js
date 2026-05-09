// One-time DB hygiene: remove all non-seed bricks accumulated from prior test
// runs. The 5 seed UUIDs (well-known across helpers/tests) are preserved.
const p = require('../src/lib/prisma');

const SEED_IDS = [
  '11111111-1111-4111-8111-111111111101',
  '11111111-1111-4111-8111-111111111102',
  '11111111-1111-4111-8111-111111111103',
  '11111111-1111-4111-8111-111111111104',
  '11111111-1111-4111-8111-111111111105',
];

const TABLES = [
  'user_session_brick_counts',
  'daily_session_set_items',
  'active_votes',
  'trust_score_events',
  'xp_events',
  'vote_events',
  'vote_intents',
  'brick_value_drivers',
  'context_sessions',
  'user_brick_progress',
  'dex_event_log',
  'user_brick_vote_credits',
  'brick_freeze_window_events',
  'pricing_cycle_close_events',
  'brick_price_history',
  'brick_price_state',
];

(async () => {
  const ids = await p.$queryRawUnsafe(
    `SELECT id FROM bricks WHERE id <> ALL($1::text[])`,
    SEED_IDS
  );
  const bids = ids.map((r) => r.id);
  console.log('non-seed bricks to delete:', bids.length);
  if (bids.length === 0) {
    await p.$disconnect();
    return;
  }
  for (const tbl of TABLES) {
    try {
      await p.$queryRawUnsafe(
        `DELETE FROM ${tbl} WHERE brick_id = ANY($1::text[])`,
        bids
      );
    } catch (e) {
      console.log(tbl, e.message);
    }
  }
  await p.$queryRawUnsafe(
    `DELETE FROM bricks WHERE id = ANY($1::text[])`,
    bids
  );
  console.log('done');
  await p.$disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
