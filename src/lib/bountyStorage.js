'use strict';

// bountyStorage — injectable provider for the `bounty-submissions` Storage
// bucket client (the bucket-scoped shape ImageUploadService expects: an object
// with .upload and .createSignedUrl).
//
// Phase B Unit 2.1 builds the upload endpoint against this seam with a fake
// injected in tests. Unit 5.2 provisions the real bucket and calls
// setBountyStorage(supabase.storage.from('bounty-submissions')) at startup —
// zero controller rework. Until wired, getBountyStorage() throws loudly so a
// missing configuration can never pass silently.

let _storage = null;

function getBountyStorage() {
  if (!_storage) {
    throw new Error(
      'bounty storage client not configured — wired in Phase B Unit 5.2 (setBountyStorage)'
    );
  }
  return _storage;
}

function setBountyStorage(client) {
  _storage = client;
}

module.exports = { getBountyStorage, setBountyStorage };
