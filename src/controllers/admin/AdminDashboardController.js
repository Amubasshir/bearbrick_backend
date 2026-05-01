/**
 * AdminDashboardController — admin-only analytics and bulk operations.
 *
 *   GET   /admin/bricks                — paginated brick list with stats
 *   GET   /admin/users                 — paginated user list with XP + completion
 *   POST  /admin/bricks/bulk-status    — update status of multiple bricks
 *   PATCH /admin/bricks/:id/feature    — toggle featured flag
 *   GET   /admin/bricks/:id/event-log  — audit trail for a brick
 */
const prisma = require("../../lib/prisma");
const { getLevel } = require("../../services/dex/XpService");

/**
 * GET /admin/bricks?page=1&limit=20
 */
async function listBricks(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const [bricks, total] = await Promise.all([
    prisma.brick.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.brick.count(),
  ]);

  if (bricks.length === 0) {
    return res.json({ success: true, data: [], pagination: { page, limit, total: 0, pages: 0 } });
  }

  const brickIds = bricks.map((b) => b.id);

  const [stageCounts, driverBreakdown] = await Promise.all([
    prisma.userBrickProgress.groupBy({
      by: ["brickId", "stage"],
      where: { brickId: { in: brickIds } },
      _count: { stage: true },
    }),
    prisma.brickValueDriver.groupBy({
      by: ["brickId", "axis"],
      where: { brickId: { in: brickIds } },
      _count: { axis: true },
    }),
  ]);

  // Build per-brick stage maps
  const stageMap = {};
  for (const row of stageCounts) {
    if (!stageMap[row.brickId]) stageMap[row.brickId] = { 0: 0, 1: 0, 2: 0, 3: 0 };
    stageMap[row.brickId][row.stage] = row._count.stage;
  }

  // Build per-brick driver breakdown
  const driverMap = {};
  for (const row of driverBreakdown) {
    if (!driverMap[row.brickId]) driverMap[row.brickId] = {};
    driverMap[row.brickId][row.axis] = row._count.axis;
  }

  const data = bricks.map((brick) => {
    const byStage = stageMap[brick.id] ?? { 0: 0, 1: 0, 2: 0, 3: 0 };
    return {
      ...brick,
      retail_price: brick.retailPrice ? Number(brick.retailPrice) : null,
      stats: {
        users_by_stage: byStage,
        total_completions: byStage[3],
        value_driver_breakdown: driverMap[brick.id] ?? {},
      },
    };
  });

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

/**
 * GET /admin/users?page=1&limit=20
 */
async function listUsers(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      skip,
      take: limit,
      select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
    }),
    prisma.user.count(),
  ]);

  if (users.length === 0) {
    return res.json({ success: true, data: [], pagination: { page, limit, total: 0, pages: 0 } });
  }

  const userIds = users.map((u) => u.id);

  const [xpRows, completionRows] = await Promise.all([
    prisma.xpEvent.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _sum: { xpAmount: true },
    }),
    prisma.userBrickProgress.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, stage: 3 },
      _count: { brickId: true },
    }),
  ]);

  const xpMap = new Map(xpRows.map((r) => [String(r.userId), r._sum.xpAmount || 0]));
  const completionMap = new Map(completionRows.map((r) => [String(r.userId), r._count.brickId]));

  const totalPublished = await prisma.brick.count({ where: { status: "PUBLISHED" } });

  const data = users.map((u) => {
    const totalXp = xpMap.get(String(u.id)) || 0;
    const { level } = getLevel(totalXp);
    const completed = completionMap.get(String(u.id)) || 0;
    const completionPct = totalPublished > 0 ? Math.round((completed / totalPublished) * 100) : 0;
    return {
      id: String(u.id),
      name: u.name,
      email: u.email,
      is_admin: u.isAdmin,
      created_at: u.createdAt,
      total_xp: totalXp,
      level,
      completed_bricks: completed,
      completion_pct: completionPct,
    };
  });

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

/**
 * POST /admin/bricks/bulk-status
 * Body: { ids: string[], status: BrickStatus }
 */
async function bulkStatus(req, res) {
  const { ids, status } = req.body;
  const VALID_STATUSES = ["UNRELEASED", "PROTOTYPE", "PUBLISHED"];

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(422).json({ success: false, message: "ids must be a non-empty array." });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(422).json({
      success: false,
      message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
    });
  }

  const now = new Date();
  const result = await prisma.brick.updateMany({
    where: {
      id: { in: ids },
      // Only set releasedAt for those not already published
    },
    data: {
      status,
      ...(status === "PUBLISHED" ? { releasedAt: now } : {}),
    },
  });

  res.json({ success: true, updated: result.count });
}

/**
 * PATCH /admin/bricks/:id/feature
 * Body: { featured: bool }
 */
async function featureBrick(req, res) {
  const { id } = req.params;
  const { featured } = req.body;

  if (typeof featured !== "boolean") {
    return res.status(422).json({ success: false, message: "featured must be a boolean." });
  }

  const existing = await prisma.brick.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  const brick = await prisma.brick.update({ where: { id }, data: { featured } });
  res.json({ success: true, data: brick });
}

/**
 * GET /admin/bricks/:id/event-log?page=1&limit=50
 */
async function getBrickEventLog(req, res) {
  const { id } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;

  const brick = await prisma.brick.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!brick) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  const [events, total] = await Promise.all([
    prisma.dexEventLog.findMany({
      where: { brickId: id },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.dexEventLog.count({ where: { brickId: id } }),
  ]);

  res.json({
    success: true,
    data: events.map((e) => ({ ...e, id: String(e.id), userId: String(e.userId) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

module.exports = { listBricks, listUsers, bulkStatus, featureBrick, getBrickEventLog };
