/**
 * DexProfileController — user Dex profile, XP, stats, and progress endpoints.
 *
 *   GET /dex/me           — full profile
 *   GET /dex/me/xp        — XP + level + paginated history
 *   GET /dex/me/stats     — personal catalogue stats
 *   GET /dex/me/progress  — paginated brick list with user stage
 */
const prisma = require("../../lib/prisma");
const { getXpProfile, getXpHistory } = require("../../services/dex/XpService");
const { getUserStats } = require("../../services/dex/DexStatsService");
const { buildStateFromRecords } = require("../../services/dex/BrickViewStateService");

/**
 * GET /dex/me
 */
async function getProfile(req, res) {
  const userId = req.user.id;

  const [xpProfile, stats, recentCompleted] = await Promise.all([
    getXpProfile(userId),
    getUserStats(userId),
    prisma.userBrickProgress.findMany({
      where: { userId, stage: 3 },
      orderBy: { stage3At: "desc" },
      take: 5,
      select: { brickId: true, stage3At: true },
    }),
  ]);

  const recentBrickIds = recentCompleted.map((r) => r.brickId);
  const recentBricks =
    recentBrickIds.length > 0
      ? await prisma.brick.findMany({
          where: { id: { in: recentBrickIds } },
          select: { id: true, name: true, imageUrl: true, series: true },
        })
      : [];
  const brickMap = new Map(recentBricks.map((b) => [b.id, b]));

  res.json({
    success: true,
    data: {
      user: {
        id: String(req.user.id),
        name: req.user.name,
        email: req.user.email,
      },
      xp: xpProfile,
      stats,
      recently_completed: recentCompleted.map((r) => ({
        brick_id: r.brickId,
        completed_at: r.stage3At,
        brick: brickMap.get(r.brickId) ?? null,
      })),
    },
  });
}

/**
 * GET /dex/me/xp?page=1&limit=20
 */
async function getXp(req, res) {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

  const [xpProfile, { events, total }] = await Promise.all([
    getXpProfile(userId),
    getXpHistory(userId, page, limit),
  ]);

  res.json({
    success: true,
    data: {
      ...xpProfile,
      history: events,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
}

/**
 * GET /dex/me/stats
 */
async function getStats(req, res) {
  const stats = await getUserStats(req.user.id);
  res.json({ success: true, data: stats });
}

/**
 * GET /dex/me/progress?stage=1,2,3&sort=recent|stage&page=1&limit=20
 */
async function getProgress(req, res) {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  // Stage filter: ?stage=1,2,3 or ?stage=3
  const stageParam = req.query.stage;
  const stageFilter = stageParam
    ? stageParam
        .split(",")
        .map((s) => parseInt(s))
        .filter((n) => !isNaN(n) && n >= 0 && n <= 3)
    : null;

  // Sort
  const sort = req.query.sort === "stage" ? { stage: "desc" } : { updatedAt: "desc" };

  const where = {
    userId,
    ...(stageFilter ? { stage: { in: stageFilter } } : {}),
  };

  const [progresses, total] = await Promise.all([
    prisma.userBrickProgress.findMany({
      where,
      orderBy: sort,
      skip,
      take: limit,
    }),
    prisma.userBrickProgress.count({ where }),
  ]);

  if (progresses.length === 0) {
    return res.json({
      success: true,
      data: [],
      pagination: { page, limit, total: 0, pages: 0 },
    });
  }

  const brickIds = progresses.map((p) => p.brickId);

  const [bricks, priceStates, drivers] = await Promise.all([
    prisma.brick.findMany({ where: { id: { in: brickIds } } }),
    prisma.brickPriceState.findMany({ where: { brickId: { in: brickIds } } }),
    prisma.brickValueDriver.findMany({ where: { userId, brickId: { in: brickIds } } }),
  ]);

  const brickMap = new Map(bricks.map((b) => [b.id, b]));
  const priceMap = new Map(priceStates.map((p) => [p.brickId, p]));
  const progressMap = new Map(progresses.map((p) => [p.brickId, p]));
  const driverMap = new Map(drivers.map((d) => [d.brickId, d]));

  // Preserve order from progresses list
  const data = progresses
    .map((p) => {
      const brick = brickMap.get(p.brickId);
      if (!brick) return null;
      return buildStateFromRecords(
        brick,
        progressMap.get(p.brickId) ?? null,
        driverMap.get(p.brickId) ?? null,
        priceMap.get(p.brickId) ?? null
      );
    })
    .filter(Boolean);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

module.exports = { getProfile, getXp, getStats, getProgress };
