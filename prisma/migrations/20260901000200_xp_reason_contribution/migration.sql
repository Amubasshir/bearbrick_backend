-- M4 Migration 2: XpReason.CONTRIBUTION
-- Bounty XP is minted through the shared insertXpEvent helper, which casts the
-- reason to "XpReason". Bounty contributions are a genuinely new XP source, so
-- add a dedicated enum value (vs M3c/M3d's reuse of STREAK) for clean replay
-- and analytics. Isolated in its own migration so the new value is committed
-- before any code references it.

ALTER TYPE "XpReason" ADD VALUE IF NOT EXISTS 'CONTRIBUTION';
