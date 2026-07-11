'use strict';

// brickImages — sign-on-serve for canonical brick images (Goodwill Item 2).
//
// Approve+Apply stores a DURABLE storage object path ({userId}/{uuid}.ext in the
// `bounty-submissions` bucket) in a brick's canonical image column, NOT an
// expiring signed URL. This helper turns that stored path into a fresh,
// time-limited signed URL at read time, via the same bounty-submissions storage
// adapter (lib/bountyStorage, wired at startup in Unit 5.1).
//
// Values that are already absolute URLs (legacy rows, externally-hosted images)
// pass through untouched — only bare object paths are re-signed. Storage is
// touched ONLY when there is at least one signable path, so a brick with no
// bounty images never reaches the storage client (keeps the hermetic test suite,
// which never configures storage, from throwing).

const { getBountyStorage } = require('./bountyStorage');

// The five canonical brick columns that hold a bounty IMAGE reference (camelCase
// Prisma field names). DATA fields (releaseYear/releaseMethod/notes) and the
// primary `imageUrl` are intentionally excluded.
const BOUNTY_IMAGE_FIELDS = [
  'packagingFrontImageUrl',
  'packagingBackImageUrl',
  'backImageUrl',
  'sideImageUrl',
  'bottomStampImageUrl',
];

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

// A stored value is a signable storage path when it is a non-empty string that is
// NOT already an absolute http(s) URL.
function isStoragePath(value) {
  return typeof value === 'string' && value.length > 0 && !/^https?:\/\//i.test(value);
}

/**
 * Turn a durable object path into a fresh signed URL via the bucket-scoped storage
 * client (.createSignedUrl(path, ttl) -> { data, error }). `storage` may be passed
 * for tests; otherwise the configured bounty storage is used.
 */
async function signStoragePath(path, ttl = DEFAULT_TTL_SECONDS, storage = null) {
  const s = storage || getBountyStorage();
  const res = await s.createSignedUrl(path, ttl);
  if (res && res.error) {
    throw new Error(res.error.message || String(res.error));
  }
  return (res && res.data && res.data.signedUrl)
    ? res.data.signedUrl
    : (res && res.signedUrl) || null;
}

/**
 * Return a shallow copy of `brick` with every bounty image field that holds a bare
 * storage path replaced by a fresh signed URL. Null / already-absolute-URL fields
 * pass through untouched. When no field is signable the input brick is returned
 * as-is and the storage client is never accessed.
 */
async function signBrickImageFields(brick, { ttl = DEFAULT_TTL_SECONDS, storage = null } = {}) {
  if (!brick) return brick;
  const toSign = BOUNTY_IMAGE_FIELDS.filter((f) => isStoragePath(brick[f]));
  if (toSign.length === 0) return brick;
  const s = storage || getBountyStorage();
  const out = { ...brick };
  for (const field of toSign) {
    // eslint-disable-next-line no-await-in-loop
    out[field] = await signStoragePath(out[field], ttl, s);
  }
  return out;
}

module.exports = {
  BOUNTY_IMAGE_FIELDS,
  DEFAULT_TTL_SECONDS,
  isStoragePath,
  signStoragePath,
  signBrickImageFields,
};
