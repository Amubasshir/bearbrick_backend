'use strict';

// UploadController — the separate bounty-image upload step (spec §18.1). Thin:
// auth (middleware) -> email-verify/account-state gate -> hand the raw bytes to
// ImageUploadService (real storage client injected via lib/bountyStorage) ->
// return the signed URL as contentUrl (the field POST .../submissions consumes).
// Image validation (JPG/PNG magic byte, 800x800, 10 MB) lives entirely in
// ImageUploadService/imageValidation — never re-implemented here.

const ImageUploadService = require('../../services/bounties/ImageUploadService');
const BountyEligibilityService = require('../../services/bounties/BountyEligibilityService');
const { getBountyStorage } = require('../../lib/bountyStorage');

// Map imageValidation reason codes to distinguishable user-facing messages.
const REASON_MESSAGES = {
  EMPTY: 'No image data provided.',
  INVALID_TYPE: 'Image must be a JPG or PNG.',
  CORRUPT: 'Image file is corrupt or unreadable.',
  TOO_SMALL: 'Image must be at least 800x800.',
  TOO_LARGE: 'Image must be 10 MB or smaller.',
};

function validationMessage(reasons) {
  const msgs = (reasons || []).map((r) => REASON_MESSAGES[r]).filter(Boolean);
  return msgs.length ? msgs.join(' ') : 'Image failed validation.';
}

/**
 * POST /api/uploads/bounty-image — raw image bytes (image/jpeg|image/png) in the
 * body (parsed by express.raw). Requires auth + verified email.
 */
async function bountyImage(req, res) {
  try {
    // Email-verify + account-state gate (reused Phase A eligibility check).
    const elig = BountyEligibilityService.evaluate(req.user, { requiresEmailVerification: true });
    if (!elig.eligible) {
      const message =
        elig.reason === 'email_not_verified'
          ? 'Email verification is required to upload images.'
          : 'Your account is not permitted to upload images.';
      return res.status(403).json({ success: false, message });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(422).json({ success: false, message: 'An image file is required.' });
    }

    const result = await ImageUploadService.upload(getBountyStorage(), {
      buffer: req.body,
      userId: req.user.id,
    });

    // contentUrl is the (1-hour) signed URL for immediate preview; contentPath is
    // the DURABLE object key the submission captures so Approve+Apply can store a
    // permanent reference in the canonical brick field (Goodwill Item 2).
    return res.status(200).json({
      success: true,
      data: { contentUrl: result.signedUrl, contentPath: result.path },
    });
  } catch (err) {
    if (err instanceof ImageUploadService.ImageUploadError) {
      if (err.code === 'image_validation_failed') {
        return res.status(422).json({ success: false, message: validationMessage(err.reasons) });
      }
      // invalid_storage_client / upload_failed / sign_failed — server/config side.
      console.error('[UploadController.bountyImage] storage error:', err.code, err.reasons);
      return res.status(500).json({ success: false, message: 'Image upload failed. Please try again.' });
    }
    console.error('[UploadController.bountyImage] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { bountyImage };
