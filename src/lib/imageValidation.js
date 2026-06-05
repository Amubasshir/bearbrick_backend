'use strict';

// imageValidation — lightweight, dependency-free image auto-checks (spec §11).
// Validates a raw image Buffer for: type (JPEG/PNG via magic bytes), integrity
// (parseable header), minimum dimensions, and max file size. These are the only
// checks the MVP performs — no AI / similarity / OCR (spec §11.3).
//
// Dimensions are read by parsing the file header directly (PNG IHDR, JPEG SOFn
// markers) so we add no image library. Returns granular reason codes; the
// submission service maps them to the user-facing "Failed automatic image
// validation" rejection (spec §11.2).

const ALLOWED_TYPES = ['image/jpeg', 'image/png'];
const MIN_WIDTH = 800;
const MIN_HEIGHT = 800;
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// JPEG Start-Of-Frame markers that carry the frame dimensions. Excludes
// 0xC4 (DHT), 0xC8 (JPG extension), 0xCC (DAC) which are not SOF segments.
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Detect image type from magic bytes. Returns 'image/jpeg', 'image/png', or null.
 */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (PNG_SIGNATURE.every((b, i) => buffer[i] === b)) {
    return 'image/png';
  }
  return null;
}

/**
 * Read width/height from a PNG IHDR chunk. Returns {width,height} or null.
 */
function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * Read width/height from the first JPEG SOFn marker. Walks the segment chain,
 * skipping non-SOF segments by their length. Returns {width,height} or null.
 */
function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // tolerate fill bytes between segments
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers with no length payload: SOI, EOI, RSTn, TEM.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null; // Start of Scan reached without an SOF
    if (offset + 3 >= buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Read dimensions for a known type. Returns {width,height} or null.
 */
function readImageDimensions(buffer, type) {
  if (type === 'image/png') return readPngDimensions(buffer);
  if (type === 'image/jpeg') return readJpegDimensions(buffer);
  return null;
}

/**
 * Run all MVP auto-checks on an image buffer.
 * Returns { ok, reasons, type, width, height }.
 * reason codes: EMPTY | TOO_LARGE | INVALID_TYPE | CORRUPT | TOO_SMALL.
 */
function validateImage(buffer, opts = {}) {
  const cfg = {
    allowedTypes: ALLOWED_TYPES,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxBytes: MAX_FILE_SIZE_BYTES,
    ...opts,
  };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reasons: ['EMPTY'], type: null, width: null, height: null };
  }

  const reasons = [];
  if (buffer.length > cfg.maxBytes) reasons.push('TOO_LARGE');

  const type = detectImageType(buffer);
  if (!type || !cfg.allowedTypes.includes(type)) {
    reasons.push('INVALID_TYPE');
    return { ok: false, reasons, type: type || null, width: null, height: null };
  }

  const dims = readImageDimensions(buffer, type);
  if (!dims) {
    reasons.push('CORRUPT');
    return { ok: false, reasons, type, width: null, height: null };
  }

  if (dims.width < cfg.minWidth || dims.height < cfg.minHeight) {
    reasons.push('TOO_SMALL');
  }

  return { ok: reasons.length === 0, reasons, type, width: dims.width, height: dims.height };
}

module.exports = {
  ALLOWED_TYPES,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  detectImageType,
  readPngDimensions,
  readJpegDimensions,
  readImageDimensions,
  validateImage,
};
