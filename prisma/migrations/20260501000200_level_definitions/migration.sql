-- Migration 2: level_definitions table + seed

CREATE TABLE level_definitions (
  id           BIGSERIAL    PRIMARY KEY,
  level_number INTEGER      NOT NULL UNIQUE,
  min_xp       INTEGER      NOT NULL,
  label        VARCHAR(64),
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed from src/config/xp-levels.js thresholds
INSERT INTO level_definitions (level_number, min_xp, label) VALUES
  (1,  0,     'Beginner'),
  (2,  100,   'Apprentice'),
  (3,  250,   'Collector'),
  (4,  500,   'Enthusiast'),
  (5,  1000,  'Curator'),
  (6,  2000,  'Expert'),
  (7,  3500,  'Connoisseur'),
  (8,  5000,  'Specialist'),
  (9,  7500,  'Master'),
  (10, 10000, 'Legend');
