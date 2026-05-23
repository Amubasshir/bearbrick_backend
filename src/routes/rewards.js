const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const RewardsController = require('../controllers/leaderboards/RewardsController');

router.get('/rewards/me', auth, RewardsController.listMe);
router.patch('/rewards/me/equip', auth, RewardsController.equip);

module.exports = router;
