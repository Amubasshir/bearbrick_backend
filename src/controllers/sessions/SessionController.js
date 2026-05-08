'use strict';

const SessionSetService = require('../../services/sessions/SessionSetService');

async function today(req, res) {
  try {
    const data = await SessionSetService.getTodaySetForUser(req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[SessionController.today] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { today };
