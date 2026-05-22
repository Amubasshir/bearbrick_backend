-- M3c Migration 2: challenge_daily_pool
-- Global 7-challenge daily pool per spec §11.2. Built nightly (or JIT) by the
-- Daily Pool Builder Worker. Per-user filtering happens at assignment time via
-- ImpossibilityValidator. The pool itself is global — there is no per-user pool
-- row, no per-user contribute filtering here (that lives in the validator).

CREATE TYPE "DailySlotType" AS ENUM (
  'vote_1',
  'vote_2',
  'explore',
  'maintain',
  'category_mastery',
  'contribute',
  'wildcard'
);

CREATE TABLE challenge_daily_pool (
  id               BIGSERIAL          PRIMARY KEY,
  challenge_date   DATE               NOT NULL,
  template_id      BIGINT             NOT NULL REFERENCES challenge_templates(id),
  family           "ChallengeFamily"  NOT NULL,
  slot_type        "DailySlotType"    NOT NULL,
  position         INTEGER            NOT NULL,
  generated_reason TEXT,
  created_at       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  CONSTRAINT challenge_daily_pool_date_slot_unique UNIQUE (challenge_date, slot_type)
);

CREATE INDEX challenge_daily_pool_date_idx     ON challenge_daily_pool (challenge_date);
CREATE INDEX challenge_daily_pool_template_idx ON challenge_daily_pool (template_id);
