'use strict';

// Pure unit tests for imageValidation. Builds minimal valid PNG/JPEG headers in
// memory (no fixture files, no dependency) and exercises each reason code.

const {
  detectImageType,
  readPngDimensions,
  readJpegDimensions,
  validateImage,
  MAX_FILE_SIZE_BYTES,
} = require('../../../src/lib/imageValidation');

// ── Header builders ───────────────────────────────────────────────────────────

function makePng(width, height) {
  const buf = Buffer.alloc(24);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((b, i) => {
    buf[i] = b;
  });
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// JPEG: SOI + SOF0 carrying dimensions (precision, height, width, ...).
function makeJpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length (17)
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

// JPEG with an APP0 (JFIF) segment before SOF0, to exercise segment-skipping.
function makeJpegWithApp0(width, height) {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, makeJpeg(width, height).subarray(2)]);
}

// ── detectImageType ───────────────────────────────────────────────────────────

describe('lib/imageValidation — detectImageType', () => {
  test('identifies PNG', () => {
    expect(detectImageType(makePng(800, 800))).toBe('image/png');
  });
  test('identifies JPEG', () => {
    expect(detectImageType(makeJpeg(800, 800))).toBe('image/jpeg');
  });
  test('returns null for unknown / short buffers', () => {
    expect(detectImageType(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

// ── dimension parsers ─────────────────────────────────────────────────────────

describe('lib/imageValidation — dimension parsing', () => {
  test('reads PNG dimensions', () => {
    expect(readPngDimensions(makePng(1024, 768))).toEqual({ width: 1024, height: 768 });
  });
  test('reads JPEG dimensions (SOF first)', () => {
    expect(readJpegDimensions(makeJpeg(1280, 960))).toEqual({ width: 1280, height: 960 });
  });
  test('reads JPEG dimensions past an APP0 segment', () => {
    expect(readJpegDimensions(makeJpegWithApp0(800, 800))).toEqual({ width: 800, height: 800 });
  });
  test('returns null on a JPEG with no SOF before SOS', () => {
    const noSof = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    expect(readJpegDimensions(noSof)).toBeNull();
  });
});

// ── validateImage ─────────────────────────────────────────────────────────────

describe('lib/imageValidation — validateImage', () => {
  test('passes a valid 800x800 PNG', () => {
    const r = validateImage(makePng(800, 800));
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r).toMatchObject({ type: 'image/png', width: 800, height: 800 });
  });

  test('passes a valid 800x800 JPEG', () => {
    const r = validateImage(makeJpeg(800, 800));
    expect(r.ok).toBe(true);
    expect(r.type).toBe('image/jpeg');
  });

  test('EMPTY for empty / non-buffer input', () => {
    expect(validateImage(Buffer.alloc(0)).reasons).toEqual(['EMPTY']);
    expect(validateImage(null).reasons).toEqual(['EMPTY']);
  });

  test('INVALID_TYPE for non JPEG/PNG', () => {
    const r = validateImage(Buffer.from('GIF89a-and-more-bytes-here'));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('INVALID_TYPE');
  });

  test('TOO_SMALL below the 800x800 minimum', () => {
    const r = validateImage(makePng(640, 480));
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('TOO_SMALL');
    expect(r).toMatchObject({ width: 640, height: 480 });
  });

  test('TOO_LARGE above the size cap', () => {
    // Valid PNG header padded past the max size.
    const big = Buffer.concat([makePng(800, 800), Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)]);
    const r = validateImage(big);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('TOO_LARGE');
  });

  test('CORRUPT for a jpeg-typed buffer with no parseable frame', () => {
    // 8+ bytes, valid magic, but no SOF segment at all.
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const r = validateImage(buf);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('CORRUPT');
  });

  test('respects custom thresholds', () => {
    const r = validateImage(makePng(500, 500), { minWidth: 400, minHeight: 400 });
    expect(r.ok).toBe(true);
  });
});
