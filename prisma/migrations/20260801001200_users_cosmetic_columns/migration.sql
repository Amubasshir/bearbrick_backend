-- M3d Migration 13: User cosmetic-equip columns
-- Adds the four equip-slot FK columns to "User" per spec §4.1. Equip state
-- lives on the user row (not a separate table) because there are at most 4
-- equipped slots total and reads happen on every profile / leaderboard row
-- fetch — denormalising avoids extra joins.
--
-- The FKs reference the catalogue tables created in migrations 6–9. Ownership
-- validation (does the user actually own the equipped cosmetic?) happens in
-- application code at PATCH /api/rewards/me/equip time.
--
-- All four columns are nullable (no default equip). Using ADD COLUMN IF NOT
-- EXISTS so the migration is safe to re-run.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS primary_calling_card_id BIGINT REFERENCES calling_cards(id),
  ADD COLUMN IF NOT EXISTS equipped_badge_slot_1   BIGINT REFERENCES badges(id),
  ADD COLUMN IF NOT EXISTS equipped_badge_slot_2   BIGINT REFERENCES badges(id),
  ADD COLUMN IF NOT EXISTS equipped_badge_slot_3   BIGINT REFERENCES badges(id);
