-- Goodwill Item 2: durable official-image reference.
-- The upload step (ImageUploadService) derives a durable object key
-- `{userId}/{uuid}.{ext}` in the `bounty-submissions` bucket but only the signed
-- (1-hour) content_url was persisted. This additive, nullable column captures the
-- durable object PATH so Approve+Apply can write a permanent reference into the
-- canonical brick image field (re-signed on serve), instead of an expiring URL.
-- Nullable, no default -> zero behavior change to existing rows / DATA submissions.

ALTER TABLE bounty_submissions
  ADD COLUMN IF NOT EXISTS content_path TEXT;
