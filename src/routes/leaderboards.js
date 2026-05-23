const express = require('express');
const router = express.Router();
const optionalAuth = require('../middleware/optionalAuth');
const LeaderboardController = require('../controllers/leaderboards/LeaderboardController');

router.get('/leaderboards/:key', optionalAuth, LeaderboardController.getOne);

module.exports = router;
