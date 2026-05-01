/**
 * DexStatsService — completion metrics for users, bricks, and global catalogue.
 */
const prisma = require("../../lib/prisma");
const { getTotalXp, getLevel } = require("./XpService");

/**
 * Personal Dex stats for a user.
 */
async function getUserStats(userId) {
  const [totalPublished, stageCounts, totalXp, identity] = await Promise.all([
    prisma.brick.count({ where: { status: "PUBLISHED" } }),
    prisma.userBrickProgress.groupBy({
      by: ["stage"],
      where: { userId },
      _count: { stage: true },
    }),
    getTotalXp(userId),
    prisma.userIdentityState.findUnique({ where: { userId } }),
  ]);

  const byStage = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const row of stageCounts) {
    byStage[row.stage] = row._count.stage;
  }

  const completionPct =
    totalPublished > 0
      ? Math.round((byStage[3] / totalPublished) * 100)
      : 0;

  const { level, xpToNextLevel } = getLevel(totalXp);

  return {
    total_bricks: totalPublished,
    bricks_by_stage: byStage,
    completion_pct: completionPct,
    total_xp: totalXp,
    level,
    xp_to_next_level: xpToNextLevel,
    streak_days: identity?.streakDays ?? 0,
  };
}

/**
 * Per-brick engagement stats.
 */
async function getBrickStats(brickId) {
  const [stageCounts, driverBreakdown] = await Promise.all([
    prisma.userBrickProgress.groupBy({
      by: ["stage"],
      where: { brickId },
      _count: { stage: true },
    }),
    prisma.brickValueDriver.groupBy({
      by: ["axis", "optionKey"],
      where: { brickId },
      _count: { axis: true },
    }),
  ]);

  const byStage = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const row of stageCounts) {
    byStage[row.stage] = row._count.stage;
  }

  // Stage counts are exact (one row per stage bucket); compute cumulative
  const openedCount = byStage[1] + byStage[2] + byStage[3];
  const votedCount = byStage[2] + byStage[3];
  const completedCount = byStage[3];

  return {
    unique_users_opened: openedCount,
    unique_users_voted: votedCount,
    unique_users_completed: completedCount,
    value_driver_breakdown: driverBreakdown.map((r) => ({
      axis: r.axis,
      option_key: r.optionKey,
      count: r._count.axis,
    })),
  };
}

/**
 * Global catalogue stats.
 */
async function getGlobalStats() {
  const [totalPublished, totalCompletions, mostCompletedRows, axisRows] =
    await Promise.all([
      prisma.brick.count({ where: { status: "PUBLISHED" } }),
      prisma.userBrickProgress.count({ where: { stage: 3 } }),
      prisma.userBrickProgress.groupBy({
        by: ["brickId"],
        where: { stage: 3 },
        _count: { brickId: true },
        orderBy: { _count: { brickId: "desc" } },
        take: 1,
      }),
      prisma.brickValueDriver.groupBy({
        by: ["axis"],
        _count: { axis: true },
        orderBy: { _count: { axis: "desc" } },
        take: 1,
      }),
    ]);

  let mostCompletedBrick = null;
  if (mostCompletedRows.length > 0) {
    const brick = await prisma.brick.findUnique({
      where: { id: mostCompletedRows[0].brickId },
      select: { id: true, name: true },
    });
    mostCompletedBrick = {
      brick_id: brick?.id,
      name: brick?.name,
      completions: mostCompletedRows[0]._count.brickId,
    };
  }

  return {
    total_bricks_published: totalPublished,
    total_completions: totalCompletions,
    most_completed_brick: mostCompletedBrick,
    most_popular_value_driver_axis: axisRows[0]?.axis ?? null,
  };
}

module.exports = { getUserStats, getBrickStats, getGlobalStats };
