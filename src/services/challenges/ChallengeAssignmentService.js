'use strict';

// ChallengeAssignmentService — turns the global daily pool into per-user
// assignments, and selects the per-user weekly slate directly from templates.
//
// On first meaningful action after local 5 AM reset (or first GET /challenges
// /daily after reset), getOrAssignDailies builds the pool if needed, evaluates
// each pool entry through ImpossibilityValidator, picks 5 (with overlap +
// near-duplicate rules), falls back to other active templates if necessary,
// and persists the rows.
//
// Weekly works the same way except there is no pool — the 3 slots
// (maintenance, exploration, wildcard) draw straight from challenge_templates
// using a deterministic per-user seed so each user's slate is stable for the
// week.

const prisma = require('../../lib/prisma');
const TemplateService = require('./ChallengeTemplateService');
const PoolBuilderService = require('./PoolBuilderService');
const Validator = require('./ImpossibilityValidator');
const { computeLocalDayKey, toDayKeyString } = require('../../lib/sessions');
const {
  mondayOf,
  nextLocalResetUtc,
  nextLocalMondayResetUtc,
} = require('../../lib/weeks');

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

function matchSignature(template) {
  // Two templates are "near-duplicates" if the same future event would
  // progress both equally — i.e. their (family, trigger, match, strategy) is
  // identical. We include family so that two templates with an empty match
  // but different families (e.g. 'vote' vs 'explore') are NOT collapsed.
  const ld = template.logic_definition || {};
  return JSON.stringify({
    f: template.challenge_family,
    t: ld.trigger || null,
    m: ld.match || {},
    s: ld.count_strategy || null,
  });
}

/**
 * Pick up to 5 templates honoring:
 *   - input order preserved (deterministic from caller's perspective)
 *   - near-duplicate prevention by matchSignature
 * Pure function, no DB.
 */
function selectFiveWithOverlapRule(eligible, count = 5) {
  const seen = new Set();
  const out = [];
  for (const t of eligible) {
    if (out.length >= count) break;
    const sig = matchSignature(t);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(t);
  }
  return out;
}

// Same fnv1a + mulberry32 as the pool builder; kept local to avoid coupling.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seedInt) {
  let a = seedInt | 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededPick(arr, seed) {
  if (arr.length === 0) return null;
  const rng = mulberry32(fnv1a(String(seed)));
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy[0];
}

// ---------------------------------------------------------------------------
// User context loader
// ---------------------------------------------------------------------------

async function loadUserContext(userId, nowUtc, txOrPrisma = prisma) {
  const userRows = await txOrPrisma.$queryRawUnsafe(
    `SELECT id, timezone FROM "User" WHERE id = $1`,
    BigInt(userId)
  );
  if (userRows.length === 0) throw new Error('User not found');
  const timezone = userRows[0].timezone || 'UTC';
  const progressRows = await txOrPrisma.$queryRawUnsafe(
    `SELECT current_level FROM user_progress_state WHERE user_id = $1`,
    BigInt(userId)
  );
  const level = progressRows[0] ? Number(progressRows[0].current_level) : 1;
  const localDayKey = computeLocalDayKey(nowUtc, timezone);

  return {
    userId: BigInt(userId),
    timezone,
    nowUtc,
    localDayKey,
    // M3a/M3b don't track lifecycle explicitly. Default 'active' for now —
    // when lifecycle modelling lands, swap this out without touching call
    // sites because templates' eligible_lifecycle_states drives the filter.
    lifecycleState: 'active',
    level,
  };
}

// ---------------------------------------------------------------------------
// DAILY assignment
// ---------------------------------------------------------------------------

/**
 * Return the user's 5 daily assignments for the current local day, creating
 * them on first call. Idempotent — subsequent calls within the same local day
 * return the same rows.
 */
async function getOrAssignDailies(userId, nowUtc = new Date(), prismaClient = prisma) {
  const ctx = await loadUserContext(userId, nowUtc, prismaClient);
  const dayIso = toDayKeyString(ctx.localDayKey);

  // Existing assignments for today?
  const existing = await prismaClient.$queryRawUnsafe(
    `SELECT * FROM user_challenge_assignments
      WHERE user_id = $1 AND scope = 'daily' AND assignment_date = $2::date
      ORDER BY id ASC`,
    ctx.userId, dayIso
  );
  if (existing.length > 0) return existing;

  // Ensure the global pool is built for today, then load it.
  await PoolBuilderService.ensureDailyPool(ctx.localDayKey, prismaClient);
  const poolRows = await prismaClient.$queryRawUnsafe(
    `SELECT cdp.slot_type, cdp.position, ct.*
       FROM challenge_daily_pool cdp
       JOIN challenge_templates ct ON ct.id = cdp.template_id
      WHERE cdp.challenge_date = $1::date
      ORDER BY cdp.position ASC`,
    dayIso
  );

  const repos = Validator.makeDefaultRepos(prismaClient);

  // Evaluate each pool template through the validator.
  const eligible = [];
  for (const t of poolRows) {
    const result = await Validator.evaluate(t, ctx, repos);
    if (result.satisfiable) {
      eligible.push(t);
    } else {
      // Best-effort log; never crash the assignment on log failure.
      try {
        await prismaClient.$queryRawUnsafe(
          `INSERT INTO challenge_assignment_log
             (user_id, template_id, assignment_date, decision, reason_detail)
           VALUES ($1, $2, $3::date, $4, $5::jsonb)`,
          ctx.userId, BigInt(t.id), dayIso,
          `filtered:${result.reason}`, JSON.stringify(result.detail || {})
        );
      } catch (_e) { /* swallow log errors */ }
    }
  }

  let selected = selectFiveWithOverlapRule(eligible, 5);

  // Fallback — if filtering shrunk the pool below 5, pull from any other
  // active daily template that ALSO passes the validator.
  if (selected.length < 5) {
    const allDaily = await TemplateService.listActive('daily', null, prismaClient);
    const usedIds = new Set(selected.map((t) => String(t.id)));
    const poolIds = new Set(poolRows.map((t) => String(t.id)));
    const fallbackCandidates = allDaily.filter(
      (t) => !usedIds.has(String(t.id)) && !poolIds.has(String(t.id))
    );
    for (const t of fallbackCandidates) {
      if (selected.length >= 5) break;
      const result = await Validator.evaluate(t, ctx, repos);
      if (!result.satisfiable) continue;
      // Respect near-duplicate rule
      const sigsTaken = new Set(selected.map(matchSignature));
      if (sigsTaken.has(matchSignature(t))) continue;
      selected.push(t);
    }
  }

  if (selected.length === 0) return [];

  const expiresAt = nextLocalResetUtc(ctx.localDayKey, ctx.timezone, 5);
  const eligibilitySnapshot = JSON.stringify({
    lifecycle: ctx.lifecycleState,
    level: ctx.level,
    timezone: ctx.timezone,
  });

  // Each INSERT is independently idempotent via the UNIQUE partial index on
  // (user_id, template_id, assignment_date). We deliberately avoid wrapping
  // in $transaction so this function is safe to call from inside an existing
  // worker transaction (Prisma's transactional client doesn't nest cleanly).
  const inserted = [];
  for (const t of selected) {
    const rows = await prismaClient.$queryRawUnsafe(
      `INSERT INTO user_challenge_assignments
         (user_id, template_id, scope, assignment_date, target_count,
          eligibility_snapshot, expires_at)
       VALUES ($1, $2, 'daily', $3::date, $4, $5::jsonb, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      ctx.userId, BigInt(t.id), dayIso, t.target_count, eligibilitySnapshot, expiresAt
    );
    if (rows[0]) inserted.push(rows[0]);
  }

  // Race-safe: if another concurrent assignment beat us, the ON CONFLICT
  // arms above drop our duplicate rows. Re-fetch the canonical set.
  if (inserted.length < selected.length) {
    return prismaClient.$queryRawUnsafe(
      `SELECT * FROM user_challenge_assignments
        WHERE user_id = $1 AND scope = 'daily' AND assignment_date = $2::date
        ORDER BY id ASC`,
      ctx.userId, dayIso
    );
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// WEEKLY assignment — no pool table, direct per-user seeded slate
// ---------------------------------------------------------------------------

async function getOrAssignWeeklies(userId, nowUtc = new Date(), prismaClient = prisma) {
  const ctx = await loadUserContext(userId, nowUtc, prismaClient);
  const weekKey = mondayOf(ctx.localDayKey);
  const weekKeyIso = toDayKeyString(weekKey);

  const existing = await prismaClient.$queryRawUnsafe(
    `SELECT * FROM user_challenge_assignments
      WHERE user_id = $1 AND scope = 'weekly' AND assignment_week_key = $2::date
      ORDER BY id ASC`,
    ctx.userId, weekKeyIso
  );
  if (existing.length > 0) return existing;

  const config = await TemplateService.loadChallengeConfig(prismaClient);
  const slateMix = config.weeklySlateMix; // { maintenance:'maintain', exploration:'explore', wildcard:'*' }
  const slotOrder = ['maintenance', 'exploration', 'wildcard'];

  const repos = Validator.makeDefaultRepos(prismaClient);
  const allWeekly = await TemplateService.listActive('weekly', null, prismaClient);
  const byFamily = {};
  for (const t of allWeekly) {
    if (!byFamily[t.challenge_family]) byFamily[t.challenge_family] = [];
    byFamily[t.challenge_family].push(t);
  }

  const picked = [];
  const usedIds = new Set();
  for (const slot of slotOrder) {
    const family = slateMix[slot];
    const candidates = family === '*' ? allWeekly : (byFamily[family] || []);
    const filtered = [];
    for (const t of candidates) {
      if (usedIds.has(String(t.id))) continue;
      const result = await Validator.evaluate(t, ctx, repos);
      if (result.satisfiable) filtered.push(t);
    }
    if (filtered.length === 0) continue;
    const seed = `weekly:${ctx.userId.toString()}:${weekKeyIso}:${slot}`;
    const chosen = seededPick(filtered, seed);
    if (!chosen) continue;
    picked.push({ template: chosen, slot });
    usedIds.add(String(chosen.id));
  }

  if (picked.length === 0) return [];

  const expiresAt = nextLocalMondayResetUtc(ctx.localDayKey, ctx.timezone, 5);
  const eligibilitySnapshot = JSON.stringify({
    lifecycle: ctx.lifecycleState,
    level: ctx.level,
    timezone: ctx.timezone,
  });

  // No inner $transaction — see daily inserts above for rationale.
  const inserted = [];
  for (const { template, slot } of picked) {
    const rows = await prismaClient.$queryRawUnsafe(
      `INSERT INTO user_challenge_assignments
         (user_id, template_id, scope, assignment_week_key, weekly_slot_type,
          target_count, eligibility_snapshot, expires_at)
       VALUES ($1, $2, 'weekly', $3::date, $4::"WeeklySlotType",
               $5, $6::jsonb, $7)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      ctx.userId, BigInt(template.id), weekKeyIso, slot,
      template.target_count, eligibilitySnapshot, expiresAt
    );
    if (rows[0]) inserted.push(rows[0]);
  }

  if (inserted.length < picked.length) {
    return prismaClient.$queryRawUnsafe(
      `SELECT * FROM user_challenge_assignments
        WHERE user_id = $1 AND scope = 'weekly' AND assignment_week_key = $2::date
        ORDER BY id ASC`,
      ctx.userId, weekKeyIso
    );
  }
  return inserted;
}

module.exports = {
  getOrAssignDailies,
  getOrAssignWeeklies,
  loadUserContext,
  selectFiveWithOverlapRule, // exported for unit tests
  matchSignature,
};
