'use strict';

// Static bounty-type metadata shared across the bounty services.
//
// FIELD_MAP maps each of the 8 MVP bounty types to the canonical `bricks`
// column it fills and whether it is an IMAGE or DATA bounty. This is structural
// (not a tunable value) so it lives in code. The columns were added in M4
// migration 1.
//
// calculateBountyXp implements the spec's §20.1 `calculateBountyXp(type)` hook.
// IMPORTANT: the spec lists the bounty XP *events* but specifies NO XP amounts
// anywhere. The values below are a PROPOSED default derived from the bounty's
// priority and are flagged for client confirmation — they are the one piece of
// this milestone not pinned by the spec or the clarifying answers.

const FIELD_MAP = {
  PACKAGING_FRONT: { column: 'packaging_front_image_url', kind: 'IMAGE' },
  PACKAGING_BACK:  { column: 'packaging_back_image_url',  kind: 'IMAGE' },
  BACK_OF_FIGURE:  { column: 'back_image_url',            kind: 'IMAGE' },
  SIDE_VIEW:       { column: 'side_image_url',            kind: 'IMAGE' },
  BOTTOM_STAMP:    { column: 'bottom_stamp_image_url',    kind: 'IMAGE' },
  RELEASE_YEAR:    { column: 'release_year',              kind: 'DATA' },
  RELEASE_METHOD:  { column: 'release_method',            kind: 'DATA' },
  NOTES_CONTEXT:   { column: 'notes',                     kind: 'DATA' },
};

// PROPOSED bounty XP by priority (see note above). Captured on the submission
// row at submission time (Q5) and minted on approval.
const XP_BY_PRIORITY = { HIGH: 15, MEDIUM: 10, LOW: 5 };

function calculateBountyXp(priority) {
  return XP_BY_PRIORITY[priority] != null ? XP_BY_PRIORITY[priority] : 10;
}

// PROPOSED milestone-bonus XP (same flag as XP_BY_PRIORITY: the spec names these
// XP *events* — FIRST_APPROVED_BOUNTY, TEN_APPROVED_BOUNTIES, BRICK_COMPLETED —
// but pins no amounts). Minted once each via insertXpEvent's idempotency keys.
// Flagged for client confirmation.
const MILESTONE_XP = {
  FIRST_APPROVED_BOUNTY: 25,
  TEN_APPROVED_BOUNTIES: 100,
  BRICK_COMPLETED: 50,
};

module.exports = {
  FIELD_MAP,
  XP_BY_PRIORITY,
  MILESTONE_XP,
  calculateBountyXp,
};
