-- M3d Migration 10: titles
-- Per spec §14.4. Cosmetic catalogue for titles (text labels shown next to a
-- user's display name). No tiered concept — each title is a discrete unlock.

CREATE TABLE titles (
  id         BIGSERIAL    PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(120) NOT NULL UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX titles_active_idx ON titles (is_active);
