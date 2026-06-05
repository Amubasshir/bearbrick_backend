'use strict';

const { upload, ImageUploadError } = require('../../../../src/services/bounties/ImageUploadService');

// Minimal valid 800x800 PNG header.
function makePng(width, height) {
  const buf = Buffer.alloc(24);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => { buf[i] = b; });
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeStorage({ uploadError = null, signError = null } = {}) {
  const calls = { upload: [], sign: [] };
  return {
    calls,
    upload: jest.fn(async (path, body, opts) => {
      calls.upload.push({ path, opts });
      return { data: uploadError ? null : { path }, error: uploadError };
    }),
    createSignedUrl: jest.fn(async (path, ttl) => {
      calls.sign.push({ path, ttl });
      return signError
        ? { data: null, error: signError }
        : { data: { signedUrl: `https://signed.example/${path}` }, error: null };
    }),
  };
}

describe('bounties/ImageUploadService — upload', () => {
  test('validates, uploads, and returns a signed URL', async () => {
    const storage = makeStorage();
    const res = await upload(storage, { buffer: makePng(800, 800), userId: 42 });
    expect(res.type).toBe('image/png');
    expect(res.signedUrl).toMatch(/^https:\/\/signed\.example\/42\//);
    expect(res.path).toMatch(/^42\/.*\.png$/);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.calls.upload[0].opts.contentType).toBe('image/png');
  });

  test('rejects an invalid image before touching storage', async () => {
    const storage = makeStorage();
    await expect(upload(storage, { buffer: makePng(640, 480), userId: 1 }))
      .rejects.toMatchObject({ code: 'image_validation_failed', reasons: ['TOO_SMALL'] });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('surfaces a storage upload error', async () => {
    const storage = makeStorage({ uploadError: { message: 'bucket missing' } });
    await expect(upload(storage, { buffer: makePng(800, 800), userId: 1 }))
      .rejects.toMatchObject({ code: 'upload_failed' });
  });

  test('surfaces a signing error', async () => {
    const storage = makeStorage({ signError: { message: 'cannot sign' } });
    await expect(upload(storage, { buffer: makePng(800, 800), userId: 1 }))
      .rejects.toMatchObject({ code: 'sign_failed' });
  });

  test('rejects a malformed storage client', async () => {
    await expect(upload({}, { buffer: makePng(800, 800), userId: 1 }))
      .rejects.toBeInstanceOf(ImageUploadError);
  });
});
