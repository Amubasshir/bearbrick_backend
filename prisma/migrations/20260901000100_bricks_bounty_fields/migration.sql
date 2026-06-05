-- M4 Migration 1: bricks bounty-target fields (M2-turf, additive)
-- Phase A / Q11: none of the 8 columns the auto-bounty generator scans existed
-- on `bricks`. Added here as additive nullable columns so the generator can
-- detect missing fields and so Approve+Apply can write canonical values.
-- All nullable, no defaults -> zero behavior change to existing brick code.

ALTER TABLE bricks
  ADD COLUMN IF NOT EXISTS packaging_front_image_url TEXT,
  ADD COLUMN IF NOT EXISTS packaging_back_image_url  TEXT,
  ADD COLUMN IF NOT EXISTS back_image_url            TEXT,
  ADD COLUMN IF NOT EXISTS side_image_url            TEXT,
  ADD COLUMN IF NOT EXISTS bottom_stamp_image_url    TEXT,
  ADD COLUMN IF NOT EXISTS release_year              INTEGER,
  ADD COLUMN IF NOT EXISTS release_method            TEXT,
  ADD COLUMN IF NOT EXISTS notes                     TEXT;
