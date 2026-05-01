/**
 * DexContextController
 *   POST /dex/bricks/:id/context/open     — Stage 0 → 1 (auth optional)
 *   POST /dex/bricks/:id/context/progress — Stage 1 dwell/scroll tracking (auth required)
 */
const prisma = require("../../lib/prisma");
const { getViewState } = require("../../services/dex/BrickViewStateService");
const { advanceStage, meetsStage1Criteria } = require("../../services/dex/DexProgressService");
const { checkAndUpdateStreak } = require("../../services/dex/XpService");

/**
 * POST /dex/bricks/:id/context/open
 * Auth: optional. Opens the brick context and advances stage 0 → 1 for auth users.
 */
async function open(req, res) {
  const { id } = req.params;
  const userId = req.user ? req.user.id : null;

  const brick = await prisma.brick.findUnique({ where: { id } });
  if (!brick) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  if (userId) {
    await prisma.$transaction(async (tx) => {
      const before = await tx.userBrickProgress.findUnique({
        where: { userId_brickId: { userId, brickId: id } },
      });
      await advanceStage(tx, userId, id, 1);
      // Only update streak when stage actually advanced
      const didAdvance = !before || before.stage < 1;
      if (didAdvance) {
        await checkAndUpdateStreak(tx, userId, id);
      }
    });
  }

  const state = await getViewState(id, userId);
  res.json({ success: true, data: state });
}

/**
 * POST /dex/bricks/:id/context/progress
 * Auth: required.
 * Body: { dwell_seconds: int, scroll_pct: int, interaction_seen: bool }
 * Records a context session and conditionally advances stage 0 → 1.
 */
async function progress(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  const { dwell_seconds = 0, scroll_pct = 0, interaction_seen = false } = req.body;

  const brick = await prisma.brick.findUnique({ where: { id } });
  if (!brick) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  const completed = meetsStage1Criteria(dwell_seconds, scroll_pct, interaction_seen);

  await prisma.$transaction(async (tx) => {
    // Record the session
    await tx.contextSession.create({
      data: {
        userId,
        brickId: id,
        dwellSeconds: dwell_seconds,
        scrollPct: scroll_pct,
        interactionSeen: interaction_seen,
        completed,
        idempotencyKey: req.idempotencyKey || null,
      },
    });

    // Advance to stage 1 if criteria met (also logs STAGE_ADVANCED + XP event)
    if (completed) {
      await advanceStage(tx, userId, id, 1);
      await tx.xpEvent.create({
        data: { userId, brickId: id, xpAmount: 5, reason: "DEX_STAGE1" },
      });
      await checkAndUpdateStreak(tx, userId, id);
    }
  });

  const state = await getViewState(id, userId);
  res.json({ success: true, data: state, stage1_completed: completed });
}

module.exports = { open, progress };
