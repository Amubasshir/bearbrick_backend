const express = require('express');
const router = express.Router();
const optionalAuth = require('../middleware/optionalAuth');
const auth = require('../middleware/auth');
const BountyController = require('../controllers/bounties/BountyController');

// Public reads — guests allowed (optionalAuth never 401s).
router.get('/bounties', optionalAuth, BountyController.list);
router.get('/bricks/:brickId/bounties', optionalAuth, BountyController.listForBrick);

// Caller-scoped reads — auth required (401 for guests).
router.get('/me/bounty-submissions', auth, BountyController.myList);
router.get('/me/balances', auth, BountyController.myBalances);

// Submission entry point — auth required.
router.post('/bounties/:bountyInstanceId/submissions', auth, BountyController.createSubmission);

// Payout request — auth required.
router.post('/me/payout-requests', auth, BountyController.createPayoutRequest);

module.exports = router;
