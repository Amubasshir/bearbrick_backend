'use strict';

// requirePermission(flag) — the PERMISSION layer for admin endpoints (option 2,
// FINAL). Runs AFTER adminAuth (the TRANSPORT layer). Structure is load-bearing
// and reused by every admin endpoint:
//
//   - X-Admin-Secret transport mode leaves req.user === null; it was authorized
//     upstream, so short-circuit with next() BEFORE hasPermission is ever called.
//   - Otherwise (JWT admin) enforce hasPermission(req.user, flag).
//
// There is deliberately NO path where hasPermission is computed and then
// overridden — that is what keeps option 2 from degrading into option 3. Do NOT
// teach hasPermission about secret mode; the bypass lives here, above it.

const { hasPermission } = require('../lib/permissions');

function requirePermission(flag) {
  return function (req, res, next) {
    if (req.user == null) return next(); // secret-mode: authorized by transport
    return hasPermission(req.user, flag)
      ? next()
      : res.status(403).json({ success: false, message: 'Forbidden' });
  };
}

module.exports = requirePermission;
