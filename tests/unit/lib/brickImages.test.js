'use strict';

// Goodwill Item 2 — sign-on-serve helper. Canonical brick image fields store a
// DURABLE storage path (not an expiring signed URL); this helper re-signs those
// paths into fresh time-limited URLs at read time. Pure unit test with a STUBBED
// bucket-scoped storage client (no network, no DB).

const {
  signBrickImageFields, signStoragePath, BOUNTY_IMAGE_FIELDS,
} = require('../../../src/lib/brickImages');

function stubStorage() {
  const calls = [];
  return {
    calls,
    createSignedUrl: async (path, ttl) => {
      calls.push({ path, ttl });
      return { data: { signedUrl: `https://signed.example/${path}?token=abc&exp=${ttl}` }, error: null };
    },
  };
}

describe('brickImages.signStoragePath', () => {
  test('returns the fresh signed URL from the adapter for a bare path', async () => {
    const storage = stubStorage();
    const url = await signStoragePath('7/uuid.png', 900, storage);
    expect(url).toBe('https://signed.example/7/uuid.png?token=abc&exp=900');
    expect(storage.calls).toEqual([{ path: '7/uuid.png', ttl: 900 }]);
  });
});

describe('brickImages.signBrickImageFields', () => {
  test('signs a bounty image field that holds a bare storage path', async () => {
    const storage = stubStorage();
    const brick = { id: 'b1', name: 'X', packagingBackImageUrl: '7/uuid.png' };
    const out = await signBrickImageFields(brick, { ttl: 3600, storage });
    expect(out.packagingBackImageUrl).toBe('https://signed.example/7/uuid.png?token=abc&exp=3600');
    expect(storage.calls).toEqual([{ path: '7/uuid.png', ttl: 3600 }]);
    // Non-image fields are untouched; input is not mutated.
    expect(out.name).toBe('X');
    expect(brick.packagingBackImageUrl).toBe('7/uuid.png');
  });

  test('leaves an already-absolute http(s) URL untouched and never calls storage', async () => {
    const storage = stubStorage();
    const brick = { backImageUrl: 'https://cdn.example/existing.png' };
    const out = await signBrickImageFields(brick, { storage });
    expect(out.backImageUrl).toBe('https://cdn.example/existing.png');
    expect(storage.calls).toHaveLength(0);
  });

  test('leaves null / absent image fields untouched', async () => {
    const storage = stubStorage();
    const brick = { sideImageUrl: null, bottomStampImageUrl: undefined, name: 'Y' };
    const out = await signBrickImageFields(brick, { storage });
    expect(out.sideImageUrl).toBeNull();
    expect(out.bottomStampImageUrl).toBeUndefined();
    expect(storage.calls).toHaveLength(0);
  });

  test('signs multiple bounty image fields and passes the ttl through', async () => {
    const storage = stubStorage();
    const brick = {
      packagingFrontImageUrl: '7/a.png',
      sideImageUrl: '7/b.jpg',
      imageUrl: '7/primary.png', // NOT a bounty field -> untouched
    };
    const out = await signBrickImageFields(brick, { ttl: 120, storage });
    expect(out.packagingFrontImageUrl).toBe('https://signed.example/7/a.png?token=abc&exp=120');
    expect(out.sideImageUrl).toBe('https://signed.example/7/b.jpg?token=abc&exp=120');
    expect(out.imageUrl).toBe('7/primary.png'); // primary image is not a bounty field
    expect(storage.calls.map((c) => c.path).sort()).toEqual(['7/a.png', '7/b.jpg']);
  });

  test('no signable field -> returns the brick untouched WITHOUT touching storage (hermetic)', async () => {
    // No storage injected: proves the helper never reaches getBountyStorage when
    // there is nothing to sign (the case every hermetic brick-read test hits).
    const brick = { id: 'b', name: 'Z', packagingBackImageUrl: null };
    const out = await signBrickImageFields(brick);
    expect(out).toEqual(brick);
  });

  test('BOUNTY_IMAGE_FIELDS is exactly the five canonical image columns', () => {
    expect([...BOUNTY_IMAGE_FIELDS].sort()).toEqual([
      'backImageUrl', 'bottomStampImageUrl', 'packagingBackImageUrl',
      'packagingFrontImageUrl', 'sideImageUrl',
    ]);
  });
});
