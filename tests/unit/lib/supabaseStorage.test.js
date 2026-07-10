'use strict';

// Unit 5.1 — real Supabase Storage adapter + startup wiring. CONTRACT tests only:
// @supabase/supabase-js is STUBBED (injected createClientFn) so the suite makes
// ZERO network calls. The LIVE smoke (real bucket upload) is Unit 5.2, separate.
//
// The seam (lib/bountyStorage) expects a bucket-scoped client with
// .upload(path, body, opts)->{data,error} and .createSignedUrl(path, ttl)->{data,error}
// — exactly supabase-js's storage.from(bucket). The adapter is a thin factory:
// service-role createClient -> storage.from('bounty-submissions'). No wrapper.

const {
  createBountyStorage, configureBountyStorageFromEnv,
} = require('../../../src/lib/supabaseStorage');
const { getBountyStorage, setBountyStorage } = require('../../../src/lib/bountyStorage');
const ImageUploadService = require('../../../src/services/bounties/ImageUploadService');

// Minimal valid PNG header (magic bytes + IHDR width/height) — mirrors the 2.1
// upload-endpoint fixture; enough for imageValidation to accept it.
function makePng(width, height, totalBytes = 24) {
  const buf = Buffer.alloc(totalBytes);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => { buf[i] = b; });
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// A stub @supabase/supabase-js createClient returning a StorageFileApi-shaped
// bucket client and recording calls. No network.
function makeStubClient({ signedUrl = 'https://signed.example/obj', uploadError = null, signError = null } = {}) {
  const calls = { createClient: [], from: [], upload: [], sign: [] };
  const bucketClient = {
    upload: jest.fn(async (path, body, opts) => {
      calls.upload.push({ path, opts, body });
      return { data: { path }, error: uploadError };
    }),
    createSignedUrl: jest.fn(async (path, ttl) => {
      calls.sign.push({ path, ttl });
      return { data: { signedUrl }, error: signError };
    }),
  };
  const createClientFn = jest.fn((url, key, options) => {
    calls.createClient.push({ url, key, options });
    return { storage: { from: jest.fn((b) => { calls.from.push(b); return bucketClient; }) } };
  });
  return { createClientFn, bucketClient, calls };
}

describe('createBountyStorage (real adapter factory)', () => {
  test('returns a bucket-scoped client exposing .upload and .createSignedUrl (seam contract)', () => {
    const { createClientFn } = makeStubClient();
    const storage = createBountyStorage({ url: 'https://x.supabase.co', serviceRoleKey: 'srk', createClientFn });
    expect(typeof storage.upload).toBe('function');
    expect(typeof storage.createSignedUrl).toBe('function');
  });

  test('constructs a service-role client and scopes to the bounty-submissions bucket', () => {
    const { createClientFn, calls, bucketClient } = makeStubClient();
    const storage = createBountyStorage({ url: 'https://x.supabase.co', serviceRoleKey: 'srk', createClientFn });
    expect(createClientFn).toHaveBeenCalledTimes(1);
    expect(calls.createClient[0].url).toBe('https://x.supabase.co');
    expect(calls.createClient[0].key).toBe('srk');       // service_role, not anon
    expect(calls.from).toEqual(['bounty-submissions']);
    expect(storage).toBe(bucketClient);
  });

  test('throws loud when required config is missing (no client constructed)', () => {
    const spy = jest.fn();
    expect(() => createBountyStorage({ createClientFn: spy })).toThrow(/not configured|required/i);
    expect(() => createBountyStorage({ url: 'https://x', createClientFn: spy })).toThrow();
    expect(() => createBountyStorage({ serviceRoleKey: 'k', createClientFn: spy })).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ImageUploadService against the real adapter (supabase client stubbed)', () => {
  test('validate -> upload -> signed URL flows through with zero network', async () => {
    const { createClientFn, calls } = makeStubClient({ signedUrl: 'https://signed.example/obj.png' });
    const storage = createBountyStorage({ url: 'https://x.supabase.co', serviceRoleKey: 'srk', createClientFn });

    const res = await ImageUploadService.upload(storage, { buffer: makePng(800, 800), userId: 42 });

    expect(res.signedUrl).toBe('https://signed.example/obj.png');
    expect(res.path).toMatch(/^42\/.*\.png$/);
    expect(res.type).toBe('image/png');
    expect(calls.upload).toHaveLength(1);
    expect(calls.upload[0].path).toMatch(/^42\/.*\.png$/);
    expect(calls.upload[0].opts.contentType).toBe('image/png');
    expect(calls.sign).toHaveLength(1);
  });
});

describe('configureBountyStorageFromEnv (startup wiring)', () => {
  afterEach(() => setBountyStorage(null));

  test('wires the real adapter into the seam when env is present', () => {
    const { createClientFn } = makeStubClient();
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' };
    const storage = configureBountyStorageFromEnv(env, createClientFn);
    expect(getBountyStorage()).toBe(storage);
    expect(typeof getBountyStorage().upload).toBe('function');
  });

  test('accepts the bare SUPABASE_URL name too', () => {
    const { createClientFn, calls } = makeStubClient();
    configureBountyStorageFromEnv({ SUPABASE_URL: 'https://y.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' }, createClientFn);
    expect(calls.createClient[0].url).toBe('https://y.supabase.co');
  });

  test('fails loud when required env is absent (no silent fallback)', () => {
    expect(() => configureBountyStorageFromEnv({}, jest.fn())).toThrow(/not configured|required/i);
  });
});
