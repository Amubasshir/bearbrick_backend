'use strict';

// Goodwill Item 2 — sign-on-serve wiring at a real brick-read endpoint. The admin
// brick responses return the raw brick record; a canonical bounty image field that
// holds a DURABLE storage path must come back as a FRESH signed URL, never the bare
// path. Storage is stubbed via setBountyStorage (hermetic — jest gives each test
// file its own module registry, so this never leaks to other suites).

const { app, adminReq } = require('../helpers/dex');
const { createBrick, cleanup } = require('../services/bounties/helpers');
const { setBountyStorage } = require('../../src/lib/bountyStorage');

function stubStorage() {
  return {
    createSignedUrl: async (path, ttl) => ({
      data: { signedUrl: `https://signed.test/${path}?exp=${ttl}` }, error: null,
    }),
  };
}

beforeAll(() => { setBountyStorage(stubStorage()); });
afterAll(async () => { setBountyStorage(null); await cleanup(); });

describe('PATCH /api/admin/bricks/:id — sign-on-serve of durable bounty image paths', () => {
  test('a stored durable path is returned as a fresh signed URL, not the bare path', async () => {
    const PATH = '7/official-packaging-uuid.png';
    const brickId = await createBrick({ tag: 'imgserve', fields: { packaging_back_image_url: PATH } });

    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`).send({ colorway: 'Silver' });
    expect(res.status).toBe(200);
    expect(res.body.data.packagingBackImageUrl).toBe(`https://signed.test/${PATH}?exp=3600`);
    expect(res.body.data.packagingBackImageUrl).not.toBe(PATH); // bare path not leaked
    expect(res.body.data.colorway).toBe('Silver');             // normal edit still applied
  });

  test('a brick with no bounty image path is returned unchanged (null stays null)', async () => {
    const brickId = await createBrick({ tag: 'imgserve2' });
    const res = await adminReq().patch(`/api/admin/bricks/${brickId}`).send({ colorway: 'Gold' });
    expect(res.status).toBe(200);
    expect(res.body.data.packagingBackImageUrl).toBeNull();
    expect(res.body.data.colorway).toBe('Gold');
  });
});
