const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SessionController = require('../controllers/sessions/SessionController');

router.get('/sessions/today', auth, SessionController.today);

module.exports = router;
