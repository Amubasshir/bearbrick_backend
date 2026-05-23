const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const InboxController = require('../controllers/leaderboards/InboxController');

router.get('/progress/inbox', auth, InboxController.list);
router.patch('/progress/inbox/:id/read', auth, InboxController.markRead);

module.exports = router;
