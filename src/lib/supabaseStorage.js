'use strict';

// supabaseStorage — the real Supabase Storage client for the `bounty-submissions`
// bucket, wired into the lib/bountyStorage seam at server startup (Unit 5.1).
//
// The seam expects a bucket-scoped object with .upload(path, body, opts) and
// .createSignedUrl(path, ttl), both returning { data, error } — which is exactly
// @supabase/supabase-js's storage.from(bucket) (StorageFileApi). So this is a thin
// factory, NOT a wrapper: construct a SERVICE_ROLE client (server-side uploads
// bypass RLS; the anon key cannot write to a private bucket) and return the
// bucket-scoped client. ImageUploadService already owns validation, object-key
// derivation, upload, and signing — nothing is re-implemented here.
//
// createClientFn is injectable so the contract tests stub supabase-js and the
// suite stays hermetic (zero network). Missing config fails LOUD — production must
// never silently fall back to an unconfigured/fake client.

const { createClient } = require('@supabase/supabase-js');
const { setBountyStorage } = require('./bountyStorage');
const { BUCKET } = require('../services/bounties/ImageUploadService');

/**
 * Build the real bounty-submissions storage client. Throws if url/serviceRoleKey
 * are missing (before any client is constructed). Returns the bucket-scoped
 * StorageFileApi that satisfies the bountyStorage seam contract.
 */
function createBountyStorage({ url, serviceRoleKey, createClientFn = createClient } = {}) {
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase storage not configured: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) '
      + 'and SUPABASE_SERVICE_ROLE_KEY are required',
    );
  }
  const client = createClientFn(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client.storage.from(BUCKET);
}

/**
 * Resolve config from env and wire the real client into the seam
 * (setBountyStorage). Called once at server startup (src/server.js). Accepts the
 * bare SUPABASE_URL or the NEXT_PUBLIC_SUPABASE_URL name. Fails loud on missing
 * config so a misconfigured deploy cannot boot with broken uploads. Returns the
 * wired client.
 */
function configureBountyStorageFromEnv(env = process.env, createClientFn = createClient) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const storage = createBountyStorage({ url, serviceRoleKey, createClientFn });
  setBountyStorage(storage);
  return storage;
}

module.exports = { createBountyStorage, configureBountyStorageFromEnv };
