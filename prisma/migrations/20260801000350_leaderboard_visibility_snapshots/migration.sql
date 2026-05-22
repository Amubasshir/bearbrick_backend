-- M3d Migration 4: leaderboard_visibility_snapshots
-- The anti-sniping window-start snapshot. The read API freezes leaderboard
-- visibility for the last N seconds before period_end (per spec §8.7 and
-- §18.5). This table holds a snapshot taken at window-start so late-window
-- score changes don't shift visible ranks, while the worker keeps updating
-- leaderboard_state in the background.
--
-- Separate from leaderboard_period_finalizations because the two have
-- different lifecycles: this is written DURING the window, the finalization
-- row is written AFTER period_end. UNIQUE(lb_key, period_key) makes duplicate
-- writes harmless. After finalization, the read API stops consulting this
-- table; the row stays for audit.

CREATE TABLE leaderboard_visibility_snapshots (
  id                BIGSERIAL    PRIMARY KEY,
  leaderboard_key   VARCHAR(80)  NOT NULL,
  period_key        VARCHAR(20)  NOT NULL,
  snapshot_taken_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  top_snapshot      JSONB        NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_visibility_snapshots_key_period_unique
    UNIQUE (leaderboard_key, period_key)
);

CREATE INDEX leaderboard_visibility_snapshots_key_idx
  ON leaderboard_visibility_snapshots (leaderboard_key, snapshot_taken_at DESC);
