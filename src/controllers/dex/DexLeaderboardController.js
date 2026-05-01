/**
 * DexLeaderboardController
 *
 *   GET /dex/leaderboard/xp         — top 50 users by total XP
 *   GET /dex/leaderboard/completion  — top 50 users by completion %
 */
const prisma = require("../../lib/prisma");
const { getLevel } = require("../../services/dex/XpService");

/**
 * GET /dex/leaderboard/xp
 */
async function xpLeaderboard(req, res) {
  // Aggregate XP per user, ordered descending
  const rows = await prisma.xpEvent.groupBy({
    by: ["userId"],
    _sum: { xpAmount: true },
    orderBy: { _sum: { xpAmount: "desc" } },
    take: 50,
  });

  if (rows.length === 0) {
    return res.json({ success: true, data: [] });
  }

  const userIds = rows.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map((u) => [String(u.id), u]));

  const data = rows.map((row, idx) => {
    const totalXp = row._sum.xpAmount || 0;
    const { level } = getLevel(totalXp);
    const user = userMap.get(String(row.userId));
    return {
      rank: idx + 1,
      user_id: String(row.userId),
      name: user?.name ?? "Unknown",
      total_xp: totalXp,
      level,
    };
  });

  res.json({ success: true, data });
}

/**
 * GET /dex/leaderboard/completion
 */
async function completionLeaderboard(req, res) {
  const totalPublished = await prisma.brick.count({ where: { status: "PUBLISHED" } });

  if (totalPublished === 0) {
    return res.json({ success: true, data: [] });
  }

  // Count stage-3 completions per user
  const rows = await prisma.userBrickProgress.groupBy({
    by: ["userId"],
    where: { stage: 3 },
    _count: { brickId: true },
    orderBy: { _count: { brickId: "desc" } },
    take: 50,
  });

  if (rows.length === 0) {
    return res.json({ success: true, data: [] });
  }

  const userIds = rows.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map((u) => [String(u.id), u]));

  const data = rows.map((row, idx) => {
    const completed = row._count.brickId;
    const completionPct = Math.round((completed / totalPublished) * 100);
    const user = userMap.get(String(row.userId));
    return {
      rank: idx + 1,
      user_id: String(row.userId),
      name: user?.name ?? "Unknown",
      completed_bricks: completed,
      total_bricks: totalPublished,
      completion_pct: completionPct,
    };
  });

  res.json({ success: true, data });
}

module.exports = { xpLeaderboard, completionLeaderboard };
