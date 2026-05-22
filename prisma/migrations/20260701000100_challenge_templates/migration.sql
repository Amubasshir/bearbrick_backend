-- M3c Migration 1: challenge_templates
-- Database-driven challenge definitions. Adding a new challenge after launch =
-- inserting a new row (logic_definition jsonb declares matcher rules), so most
-- new challenges need no code change. Per spec §11.1 and Q4.

CREATE TYPE "ChallengeFamily" AS ENUM (
  'vote',
  'explore',
  'maintain',
  'contribute',
  'category_mastery'
);

CREATE TYPE "ChallengeScope" AS ENUM (
  'daily',
  'weekly'
);

CREATE TABLE challenge_templates (
  id                            BIGSERIAL         PRIMARY KEY,
  code                          VARCHAR(120)      NOT NULL UNIQUE,
  display_title                 TEXT              NOT NULL,
  description_template          TEXT              NOT NULL,
  challenge_family              "ChallengeFamily" NOT NULL,
  scope                         "ChallengeScope"  NOT NULL,
  difficulty_band_min           INTEGER           NOT NULL DEFAULT 1,
  difficulty_band_max           INTEGER           NOT NULL DEFAULT 99,
  eligible_lifecycle_states     TEXT[]            NOT NULL DEFAULT ARRAY['pre_activated','active','dormant','elite']::TEXT[],
  requires_contribution_access  BOOLEAN           NOT NULL DEFAULT FALSE,
  requires_stale_targets        BOOLEAN           NOT NULL DEFAULT FALSE,
  requires_category_target      BOOLEAN           NOT NULL DEFAULT FALSE,
  requires_session_target       BOOLEAN           NOT NULL DEFAULT FALSE,
  is_active                     BOOLEAN           NOT NULL DEFAULT TRUE,
  logic_definition              JSONB             NOT NULL,
  reward_xp_base                INTEGER           NOT NULL,
  reward_xp_bonus               INTEGER           NOT NULL DEFAULT 0,
  target_count                  INTEGER           NOT NULL,
  time_window                   JSONB,
  logic_version                 VARCHAR(32)       NOT NULL DEFAULT 'm3c_v1',
  created_at                    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  CONSTRAINT challenge_templates_target_count_positive CHECK (target_count > 0),
  CONSTRAINT challenge_templates_reward_xp_base_nonneg CHECK (reward_xp_base >= 0),
  CONSTRAINT challenge_templates_reward_xp_bonus_nonneg CHECK (reward_xp_bonus >= 0)
);

CREATE INDEX challenge_templates_family_active_idx
  ON challenge_templates (challenge_family, is_active);
CREATE INDEX challenge_templates_scope_active_idx
  ON challenge_templates (scope, is_active);
