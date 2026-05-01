/**
 * Rate limit for POST /api/vote_intents. Spec §3.1: "Rate-limited before insert".
 * Limits per authenticated user (auth runs before this).
 */
require("dotenv").config();
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const windowMs =
  parseInt(process.env.RATE_LIMIT_VOTE_WINDOW_MS, 10) || 60 * 1000; // 1 minute
const max = parseInt(process.env.RATE_LIMIT_VOTE_MAX, 10) || 20; // 20 vote intents per window per user

const rateLimitVoteIntents = rateLimit({
  windowMs,
  max,
  message: {
    success: false,
    message: "Too many vote attempts. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    // vote_intents route uses auth first, so req.user is set
    if (req.user && req.user.id != null) {
      return `user:${req.user.id}`;
    }
    return ipKeyGenerator(req.ip || "0.0.0.0");
  },
});

module.exports = rateLimitVoteIntents;
