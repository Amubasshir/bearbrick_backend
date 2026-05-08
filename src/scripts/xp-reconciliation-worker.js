'use strict';

const prisma = require('../lib/prisma');

// ---------------------------------------------------------------------------
// Pure functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Resolve which level a user is at given total XP and an ordered level table.
 * levelDefinitions must be sorted ascending by level_number.
 * Returns the highest level whose min_xp <= totalXp (minimum 1).
 */
function resolveLevel(totalXp, levelDefinitions) {
  let resolved = 1;
  for (const def of levelDefinitions) {
    if (!def.is_active) continue;
    if (def.min_xp <= totalXp) {
      resolved = def.level_number;
    }
  }
  return resolved;
}

/**
 * Apply a single confirmed xp_event to the current state.
 * Never decreases current_level (hard rule).
 * Returns { newState, levelUpEvent | null }.
 */
function applyEvent(currentState, event, levelDefinitions) {
  const newTotal = currentState.total_xp_confirmed + event.xp_delta_signed;
  const resolvedLevel = resolveLevel(newTotal, levelDefinitions);

  let levelUpEvent = null;
  let newLevel = currentState.current_level;
  let newHighest = currentState.highest_level_ever;

  if (resolvedLevel > currentState.current_level) {
    levelUpEvent = {
      from_level: currentState.current_level,
      to_level: resolvedLevel,
      triggered_by_xp_event_id: event.id,
    };
    newLevel = resolvedLevel;
    newHighest = Math.max(newHighest, resolvedLevel);
  }

  const newState = {
    ...currentState,
    total_xp_confirmed: newTotal,
    current_level: newLevel,
    highest_level_ever: newHighest,
    last_reconciled_xp_event_id: event.id,
  };

  return { newState, levelUpEvent };
}

// ---------------------------------------------------------------------------
// Integration-testable runner — exported for integration tests
// ---------------------------------------------------------------------------

/**
 * Process all unreconciled confirmed xp_events for one user inside a
 * transaction with a per-user advisory lock.
 */
async function processUser(userId, prismaClient, levelDefs) {
  const userIdBig = typeof userId === 'bigint' ? userId : BigInt(userId);

  await prismaClient.$transaction(async (tx) => {
    // Advisory lock scoped to this transaction — prevents concurrent runs for same user
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1)`,
      userIdBig
    );

    // Fetch or bootstrap progress state
    let stateRows = await tx.$queryRawUnsafe(
      `SELECT user_id, total_xp_confirmed, current_level, highest_level_ever,
              last_reconciled_xp_event_id
       FROM user_progress_state
       WHERE user_id = $1
       FOR UPDATE`,
      userIdBig
    );

    let state;
    if (stateRows.length === 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO user_progress_state
           (user_id, total_xp_confirmed, current_level, highest_level_ever,
            last_reconciled_xp_event_id, updated_at)
         VALUES ($1, 0, 1, 1, 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        userIdBig
      );
      stateRows = await tx.$queryRawUnsafe(
        `SELECT user_id, total_xp_confirmed, current_level, highest_level_ever,
                last_reconciled_xp_event_id
         FROM user_progress_state
         WHERE user_id = $1
         FOR UPDATE`,
        userIdBig
      );
    }

    state = {
      total_xp_confirmed: Number(stateRows[0].total_xp_confirmed),
      current_level: Number(stateRows[0].current_level),
      highest_level_ever: Number(stateRows[0].highest_level_ever),
      last_reconciled_xp_event_id: BigInt(stateRows[0].last_reconciled_xp_event_id),
    };

    // Fetch unprocessed confirmed events in deterministic order
    const events = await tx.$queryRawUnsafe(
      `SELECT id, xp_delta_signed
       FROM xp_events
       WHERE user_id = $1
         AND xp_confirmed = TRUE
         AND id > $2
       ORDER BY "createdAt" ASC, id ASC`,
      userIdBig,
      state.last_reconciled_xp_event_id
    );

    if (events.length === 0) return;

    const levelUpEventsToInsert = [];

    for (const event of events) {
      const ev = {
        id: BigInt(event.id),
        xp_delta_signed: Number(event.xp_delta_signed),
      };
      const { newState, levelUpEvent } = applyEvent(state, ev, levelDefs);
      state = newState;
      if (levelUpEvent) {
        levelUpEventsToInsert.push(levelUpEvent);
      }
    }

    // Bulk insert level_up_events
    for (const lue of levelUpEventsToInsert) {
      await tx.$executeRawUnsafe(
        `INSERT INTO level_up_events
           (user_id, from_level, to_level, triggered_by_xp_event_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        userIdBig,
        lue.from_level,
        lue.to_level,
        lue.triggered_by_xp_event_id
      );
    }

    // Update progress state
    await tx.$executeRawUnsafe(
      `UPDATE user_progress_state
       SET total_xp_confirmed          = $2,
           current_level               = $3,
           highest_level_ever          = $4,
           last_reconciled_xp_event_id = $5,
           updated_at                  = NOW()
       WHERE user_id = $1`,
      userIdBig,
      state.total_xp_confirmed,
      state.current_level,
      state.highest_level_ever,
      state.last_reconciled_xp_event_id
    );
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — batch loop, only runs when invoked directly
// ---------------------------------------------------------------------------

async function runWorkerLoop() {
  console.log('[xp-worker] starting');

  const levelDefs = await prisma.$queryRaw`
    SELECT level_number, min_xp, is_active
    FROM level_definitions
    WHERE is_active = TRUE
    ORDER BY level_number ASC
  `;

  const POLL_INTERVAL_MS = 5000;
  const BATCH_SIZE = 50;

  while (true) {
    try {
      const users = await prisma.$queryRawUnsafe(`
        SELECT DISTINCT xe.user_id
        FROM xp_events xe
        LEFT JOIN user_progress_state ups ON ups.user_id = xe.user_id
        WHERE xe.xp_confirmed = TRUE
          AND xe.id > COALESCE(ups.last_reconciled_xp_event_id, 0)
        ORDER BY xe.user_id ASC
        LIMIT ${BATCH_SIZE}
      `);

      if (users.length > 0) {
        console.log(`[xp-worker] processing ${users.length} user(s)`);
        for (const { user_id } of users) {
          try {
            await processUser(user_id, prisma, levelDefs);
          } catch (err) {
            console.error(`[xp-worker] error for user ${user_id}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[xp-worker] batch error:', err.message);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { resolveLevel, applyEvent, processUser };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[xp-worker] fatal:', err);
    process.exit(1);
  });
}
