const prisma = require("../lib/prisma");
const pricing = require("../../config/pricing");

async function getFeed(req, res) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  // Check if user is email verified
  const identity = await prisma.userIdentityState.findUnique({
    where: { userId: user.id },
  });

  if (!identity || !identity.emailVerified) {
    return res.status(403).json({
      success: false,
      message: "Email verification required",
    });
  }

  const limit = parseInt(req.query.limit, 10) || 5;
  const cooldownDays = pricing.recheck_cooldown_days;
  const cooldownDate = new Date();
  cooldownDate.setDate(cooldownDate.getDate() - cooldownDays);

  // Get bricks that need recheck
  const recheckBricks = await prisma.brickPriceState.findMany({
    where: {
      needsRecheck: true,
      OR: [
        { recheckExpiresAt: null },
        { recheckExpiresAt: { gt: new Date() } },
      ],
    },
    orderBy: [
      // ACTIVE first
      { recheckState: "desc" },
      // Then by reason priority: POST_FREEZE > OPPOSING_SIGNAL > STALE > LOW_SAMPLE
      { recheckReason: "asc" },
    ],
  });

  // Get user's vote history to check cooldown and previous votes
  const userVotes = await prisma.voteEvent.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: cooldownDate },
    },
    select: {
      brickId: true,
      createdAt: true,
    },
  });

  const userVotedBrickIds = new Set(userVotes.map((v) => v.brickId));

  // Filter and rank bricks
  const eligibleBricks = recheckBricks
    .filter((brick) => {
      // Exclude if user voted recently (cooldown)
      if (userVotedBrickIds.has(brick.brickId)) {
        return false;
      }
      return true;
    })
    .map((brick) => {
      const livePrice = Number(brick.livePrice);
      return {
        brick_id: brick.brickId,
        live_price: livePrice,
        fair_lower: livePrice * 0.95,
        fair_upper: livePrice * 1.05,
        recheck_reason: brick.recheckReason,
        recheck_state: brick.recheckState,
        expires_at: brick.recheckExpiresAt,
        bonus_xp_multiplier: pricing.recheck_xp_multiplier,
        credit_available: true, // Credit regain is handled server-side
      };
    })
    .slice(0, limit);

  res.json({
    success: true,
    data: {
      limit: limit,
      recheck_bricks: eligibleBricks,
    },
  });
}

module.exports = { getFeed };
