const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const UploadController = require('../controllers/uploads/UploadController');

// Raw image body (JPG/PNG). Limit is set above the 10 MB rule so an oversize
// upload still reaches ImageUploadService and returns a 422 (TOO_LARGE) rather
// than a body-parser 413. Coexists with the global express.json (which skips
// non-JSON content types).
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '12mb' });

router.post('/uploads/bounty-image', auth, rawImage, UploadController.bountyImage);

module.exports = router;
