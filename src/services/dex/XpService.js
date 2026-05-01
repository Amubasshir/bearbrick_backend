/**
 * XpService — XP totals, level calculation, history, and streak management.
 */
const prisma = require("../../lib/prisma");
const XP_LEVELS = require("../../config/xp-levels");

// Streak milestone → bonus XP
const STREAK_MILESTONES = { 3: 25, 7: 50, 14: 100, 30: 250 };

/**
 * Calculate level info from total XP.
 * Returns { level, xpRequired, nextLevelXp, xpToNextLevel }.
 */
function getLevel(totalXp) {
  let currentLevel = XP_LEVELS[0];
  for (const entry of XP_LEVELS) {
    if (totalXp >= entry.xpRequired) {
      currentLevel = entry;
    } else {
      break;
    }
  }
  const nextEntry = XP_LEVELS.find((e) => e.level === currentLevel.level + 1);
  return {
    level: currentLevel.level,
    xpRequired: currentLevel.xpRequired,
    nextLevelXp: nextEntry ? nextEntry.xpRequired : null,
    xpToNextLevel: nextEntry ? Math.max(0, nextEntry.xpRequired - totalXp) : 0,
  };
}

/**
 * Sum all XP events for a user.
 */
async function getTotalXp(userId) {
  const result = await prisma.xpEvent.aggregate({
    where: { userId },
    _sum: { xpAmount: true },
  });
  return result._sum.xpAmount || 0;
}

/**
 * Return { totalXp, level, nextLevelXp, xpToNextLevel }.
 */
async function getXpProfile(userId) {
  const totalXp = await getTotalXp(userId);
  return { totalXp, ...getLevel(totalXp) };
}

/**
 * Paginated XP event history for a user.
 */
async function getXpHistory(userId, page, limit) {
  const skip = (page - 1) * limit;
  const [events, total] = await Promise.all([
    prisma.xpEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        brickId: true,
        xpAmount: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.xpEvent.count({ where: { userId } }),
  ]);
  return { events: events.map((e) => ({ ...e, id: String(e.id) })), total };
}

/**
 * Check and update the user's daily streak inside a transaction.
 * Awards bonus XP if a streak milestone is hit.
 * Call this once per stage completion.
 *
 * @param {object} tx     - Prisma transaction client
 * @param {BigInt} userId
 * @param {string} brickId - used as context for the XP event
 */
async function checkAndUpdateStreak(tx, userId, brickId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let identity = await tx.userIdentityState.findUnique({ where: { userId } });
  if (!identity) {
    // First-ever activity — create identity state with streak=1
    await tx.userIdentityState.create({
      data: {
        userId,
        emailVerified: false,
        streakDays: 1,
        lastActivityDate: today,
      },
    });
    return; // No milestone on first day
  }

  // Already counted today — nothing to do
  if (identity.lastActivityDate) {
    const last = new Date(identity.lastActivityDate);
    last.setHours(0, 0, 0, 0);
    if (last.getTime() === today.getTime()) return;
  }

  let newStreak;
  if (!identity.lastActivityDate) {
    newStreak = 1;
  } else {
    const last = new Date(identity.lastActivityDate);
    last.setHours(0, 0, 0, 0);
    newStreak = last.getTime() === yesterday.getTime()
      ? identity.streakDays + 1  // consecutive day
      : 1;                        // streak broken, reset
  }

  await tx.userIdentityState.update({
    where: { userId },
    data: { streakDays: newStreak, lastActivityDate: today },
  });

  const bonus = STREAK_MILESTONES[newStreak];
  if (bonus) {
    await tx.xpEvent.create({
      data: { userId, brickId, xpAmount: bonus, reason: "DEX_STREAK" },
    });
  }
}

module.exports = { getTotalXp, getXpProfile, getXpHistory, checkAndUpdateStreak, getLevel };
