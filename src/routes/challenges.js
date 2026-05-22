const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ChallengeController = require('../controllers/challenges/ChallengeController');

router.get('/challenges/daily', auth, ChallengeController.daily);
router.get('/challenges/weekly', auth, ChallengeController.weekly);
router.post('/challenges/assign-if-needed', auth, ChallengeController.assignIfNeeded);

module.exports = router;
