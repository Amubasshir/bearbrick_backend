'use strict';

// Unit 2.1 — POST /api/uploads/bounty-image (auth + email-verified; validates an
// image via ImageUploadService against an INJECTED fake storage client). No real
// Supabase wiring here — the fake is injected via lib/bountyStorage.setBountyStorage;
// Unit 5.2 swaps in the real client with zero controller rework.

const request = require('supertest');
const app = require('../../src/app');
const { prisma } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');
const { setBountyStorage } = require('../../src/lib/bountyStorage');
const { MAX_FILE_SIZE_BYTES } = require('../../src/lib/imageValidation');

// --- fixtures (mirror ImageUploadService.test.js's tiny header builder) ---
function makePng(width, height, totalBytes = 24) {
  const buf = Buffer.alloc(totalBytes);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => { buf[i] = b; });
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeStorage() {
  const calls = { upload: [], sign: [] };
  return {
    calls,
    upload: jest.fn(async (path, body, opts) => {
      calls.upload.push({ path, opts });
      return { data: { path }, error: null };
    }),
    createSignedUrl: jest.fn(async (path, ttl) => {
      calls.sign.push({ path, ttl });
      return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
    }),
  };
}

function postImage(token, buffer, contentType = 'image/png') {
  const req = request(app).post('/api/uploads/bounty-image');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.set('Content-Type', contentType).send(buffer);
}

let verified;    // { token, userId }, email verified
let unverified;  // { token, userId }, email_verified_at nulled
let storage;

beforeAll(async () => {
  verified = await createFreshUser('u21ok');
  unverified = await createFreshUser('u21unv');
  // Force the unverified state (createFreshUser marks email_verified:true).
  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET email_verified_at = NULL WHERE id = $1`, BigInt(unverified.userId)
  );
});

beforeEach(() => {
  storage = makeStorage();
  setBountyStorage(storage);
});

afterAll(async () => {
  setBountyStorage(null);
  await prisma.$disconnect();
});

describe('POST /api/uploads/bounty-image', () => {
  test('401 when unauthenticated', async () => {
    const res = await postImage(null, makePng(800, 800));
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/unauthenticated/i);
  });

  test('403 when the caller has not verified their email', async () => {
    const res = await postImage(unverified.token, makePng(800, 800));
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('200 for a verified caller with a valid image; returns a signed URL and hits storage', async () => {
    const res = await postImage(verified.token, makePng(800, 800));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.contentUrl).toMatch(
      new RegExp(`^https://signed\\.example/${verified.userId}/.*\\.png$`)
    );
    // Goodwill Item 2: the durable object PATH is also returned so the submission
    // can capture it. It is the bare bucket key (what the object was stored under),
    // NOT a signed URL.
    expect(res.body.data.contentPath).toBe(storage.calls.upload[0].path);
    expect(res.body.data.contentPath).toMatch(
      new RegExp(`^${verified.userId}/.*\\.png$`)
    );
    expect(res.body.data.contentPath).not.toMatch(/^https?:|token=/);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.calls.upload[0].opts.contentType).toBe('image/png');
  });

  test('422 for a non-image / bad magic bytes', async () => {
    const notAnImage = Buffer.from('this is definitely not an image at all!!');
    const res = await postImage(verified.token, notAnImage);
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/jpg|png|image/i);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('422 when the image is under 800x800', async () => {
    const res = await postImage(verified.token, makePng(640, 480));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/800/);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('422 when the image is over 10 MB', async () => {
    const big = makePng(800, 800, MAX_FILE_SIZE_BYTES + 1);
    const res = await postImage(verified.token, big);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/10\s?MB|large|size/i);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
