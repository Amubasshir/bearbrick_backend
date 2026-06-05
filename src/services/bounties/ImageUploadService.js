'use strict';

// ImageUploadService — validates an image buffer and stores it in Supabase
// Storage, returning a signed URL (Q2/Q3).
//
// The storage client is INJECTED (a bucket-scoped object exposing `.upload` and
// `.createSignedUrl`, i.e. the shape of `supabaseClient.storage.from(bucket)`).
// This keeps the service fully unit-testable in Phase A with a fake; Phase B
// wires the real @supabase/supabase-js client and provisions the
// `bounty-submissions` bucket.

const { v4: uuidv4 } = require('uuid');
const { validateImage } = require('../../lib/imageValidation');

const BUCKET = 'bounty-submissions';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png' };

class ImageUploadError extends Error {
  constructor(code, reasons) {
    super(code);
    this.name = 'ImageUploadError';
    this.code = code;
    this.reasons = reasons || [];
  }
}

/**
 * Validate + upload + sign. Returns { path, signedUrl, type, width, height }.
 * Throws ImageUploadError on validation failure or a storage error.
 *   storage: bucket-scoped client with .upload(path, body, opts) and
 *            .createSignedUrl(path, ttl) returning { data, error }.
 */
async function upload(storage, { buffer, userId, ttlSeconds = SIGNED_URL_TTL_SECONDS }) {
  if (!storage || typeof storage.upload !== 'function' || typeof storage.createSignedUrl !== 'function') {
    throw new ImageUploadError('invalid_storage_client');
  }

  const validation = validateImage(buffer);
  if (!validation.ok) {
    throw new ImageUploadError('image_validation_failed', validation.reasons);
  }

  const ext = EXT_BY_TYPE[validation.type] || 'bin';
  const objectPath = `${userId}/${uuidv4()}.${ext}`;

  const up = await storage.upload(objectPath, buffer, {
    contentType: validation.type,
    upsert: false,
  });
  if (up && up.error) {
    throw new ImageUploadError('upload_failed', [up.error.message || String(up.error)]);
  }

  const signed = await storage.createSignedUrl(objectPath, ttlSeconds);
  if (signed && signed.error) {
    throw new ImageUploadError('sign_failed', [signed.error.message || String(signed.error)]);
  }
  const signedUrl =
    signed && signed.data && signed.data.signedUrl
      ? signed.data.signedUrl
      : signed && signed.signedUrl
        ? signed.signedUrl
        : null;

  return {
    path: objectPath,
    signedUrl,
    type: validation.type,
    width: validation.width,
    height: validation.height,
  };
}

module.exports = {
  upload,
  ImageUploadError,
  BUCKET,
  SIGNED_URL_TTL_SECONDS,
};
