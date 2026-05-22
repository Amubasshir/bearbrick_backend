'use strict';

// Daily Pool Builder — owns the global 7-challenge daily pool per spec §11.2.
// Slot layout is configurable via xp_config_versions.config.challenges
// .daily_pool_family_mix; defaults to:
//   vote_1, vote_2, explore, maintain, category_mastery, contribute, wildcard.
//
// Per-user filtering (impossibility, eligibility, contribute gate) happens at
// assignment time, NOT here. The pool is global and includes the contribute
// slot even when the feature flag is off — AssignmentService's fallback will
// substitute another family if the slot's template is unsatisfiable.
//
// There is no weekly pool table — weekly slate is selected per-user in
// ChallengeAssignmentService (see plan).

const prisma = require('../../lib/prisma');
const TemplateService = require('./ChallengeTemplateService');
const { toDayKeyString } = require('../../lib/sessions');

// fnv1a + mulberry32 — same deterministic seed pattern used by SessionSetService.
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

/**
 * Pick a single template id from candidates using a deterministic shuffle.
 * `excludedIds` lets the caller avoid templates already chosen in earlier slots.
 */
function pickTemplate(candidates, seed, excludedIds) {
  const filtered = candidates.filter((c) => !excludedIds.has(String(c.id)));
  if (filtered.length === 0) return null;
  const rng = mulberry32(fnv1a(String(seed)));
  // Fisher-Yates-like single pick: shuffle order, take first.
  const arr = [...filtered];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr[0];
}

/**
 * Ensure all 7 daily pool slots exist for `challengeDate`. Idempotent — safe
 * to call concurrently (UNIQUE (challenge_date, slot_type) enforces).
 */
async function ensureDailyPool(challengeDate, txOrPrisma = prisma) {
  const dateIso = toDayKeyString(challengeDate);
  const config = await TemplateService.loadChallengeConfig(txOrPrisma);
  const slotMix = config.dailyPoolFamilyMix;

  // Existing slots for the date — we only fill what's missing.
  const existing = await txOrPrisma.$queryRawUnsafe(
    `SELECT slot_type, template_id FROM challenge_daily_pool
      WHERE challenge_date = $1::date`,
    dateIso
  );
  const haveSlots = new Set(existing.map((r) => r.slot_type));
  const excludedIds = new Set(existing.map((r) => String(r.template_id)));

  // Pre-fetch active daily templates once, group by family.
  const allActive = await TemplateService.listActive('daily', null, txOrPrisma);
  const byFamily = {};
  for (const t of allActive) {
    if (!byFamily[t.challenge_family]) byFamily[t.challenge_family] = [];
    byFamily[t.challenge_family].push(t);
  }
  // For wildcard ('*'), candidates are all active daily templates.
  const wildcardCandidates = allActive;

  // Deterministic slot order — must match the enum order so positions are stable.
  const slotOrder = ['vote_1', 'vote_2', 'explore', 'maintain', 'category_mastery', 'contribute', 'wildcard'];

  for (let position = 0; position < slotOrder.length; position++) {
    const slotType = slotOrder[position];
    if (haveSlots.has(slotType)) continue;

    const family = slotMix[slotType];
    if (family === undefined) continue; // slot not in config — skip

    const candidates = family === '*' ? wildcardCandidates : (byFamily[family] || []);
    const seed = `pool:${dateIso}:${slotType}`;
    const picked = pickTemplate(candidates, seed, excludedIds);
    if (!picked) continue; // no eligible template for this family — leave slot empty

    const inserted = await txOrPrisma.$queryRawUnsafe(
      `INSERT INTO challenge_daily_pool
         (challenge_date, template_id, family, slot_type, position, generated_reason)
       VALUES ($1::date, $2, $3::"ChallengeFamily", $4::"DailySlotType", $5, $6)
       ON CONFLICT (challenge_date, slot_type) DO NOTHING
       RETURNING id, template_id`,
      dateIso, BigInt(picked.id), picked.challenge_family, slotType, position, 'pool_builder'
    );
    if (inserted.length > 0) {
      excludedIds.add(String(inserted[0].template_id));
    } else {
      // Concurrent insert already filled the slot — read what's there so we
      // don't pick the same template again for a later slot.
      const refetch = await txOrPrisma.$queryRawUnsafe(
        `SELECT template_id FROM challenge_daily_pool
          WHERE challenge_date = $1::date AND slot_type = $2::"DailySlotType"`,
        dateIso, slotType
      );
      if (refetch[0]) excludedIds.add(String(refetch[0].template_id));
    }
  }
}

module.exports = {
  ensureDailyPool,
  pickTemplate, // exported for unit testing if needed
};
