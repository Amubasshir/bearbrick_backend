/**
 * DexValueDriverController
 *   POST /dex/bricks/:id/value-driver — Stage 3 classification (requires stage >= 2, idempotent)
 *
 * Atomically:
 *   1. Validate eligibility (stage >= 2, not yet at stage 3)
 *   2. Validate option_key against BrickValueDriverOption catalogue
 *   3. Upsert BrickValueDriver record
 *   4. Advance stage to 3 — logs STAGE_ADVANCED to DexEventLog
 *   5. Award XP (reason: DEX_STAGE3, amount: 15)
 *   6. Log VALUE_DRIVER_SET to DexEventLog
 *   7. Update daily streak
 *   8. Return BrickViewState
 */
const prisma = require("../../lib/prisma");
const { getViewState } = require("../../services/dex/BrickViewStateService");
const { getOrCreateProgress, advanceStage } = require("../../services/dex/DexProgressService");
const { checkAndUpdateStreak } = require("../../services/dex/XpService");

const VALID_AXES = ["A", "B", "C", "D"];
const VALUE_DRIVER_XP = 15;

async function submit(req, res) {
  const { id: brickId } = req.params;
  const userId = req.user.id;
  const { axis, option_key } = req.body;

  if (!VALID_AXES.includes(axis)) {
    return res.status(422).json({
      success: false,
      message: `axis must be one of: ${VALID_AXES.join(", ")}.`,
    });
  }
  if (!option_key || typeof option_key !== "string" || !option_key.trim()) {
    return res.status(422).json({
      success: false,
      message: "option_key is required.",
    });
  }

  const brick = await prisma.brick.findUnique({ where: { id: brickId } });
  if (!brick) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  // Validate option_key against catalogue (if catalogue is populated)
  const optionCount = await prisma.brickValueDriverOption.count();
  if (optionCount > 0) {
    const validOption = await prisma.brickValueDriverOption.findUnique({
      where: { axis_optionKey: { axis, optionKey: option_key.trim() } },
    });
    if (!validOption) {
      return res.status(422).json({
        success: false,
        message: `option_key '${option_key.trim()}' is not valid for axis ${axis}.`,
      });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const progress = await getOrCreateProgress(tx, userId, brickId);

      if (progress.stage < 2) {
        const err = new Error("Must vote before submitting a value driver.");
        err.statusCode = 403;
        throw err;
      }
      if (progress.stage >= 3) {
        const err = new Error("Already submitted a value driver for this brick.");
        err.statusCode = 409;
        throw err;
      }

      // Upsert BrickValueDriver
      await tx.brickValueDriver.upsert({
        where: { userId_brickId: { userId, brickId } },
        update: { axis, optionKey: option_key.trim(), idempotencyKey: req.idempotencyKey || null },
        create: {
          userId,
          brickId,
          axis,
          optionKey: option_key.trim(),
          idempotencyKey: req.idempotencyKey || null,
        },
      });

      // Advance stage to 3 (also logs STAGE_ADVANCED)
      await advanceStage(tx, userId, brickId, 3);

      // Award XP
      await tx.xpEvent.create({
        data: {
          userId,
          brickId,
          xpAmount: VALUE_DRIVER_XP,
          reason: "DEX_STAGE3",
        },
      });

      // Log value driver submission
      await tx.dexEventLog.create({
        data: {
          eventType: "VALUE_DRIVER_SET",
          userId,
          brickId,
          payload: { axis, option_key: option_key.trim() },
        },
      });

      // Update daily streak
      await checkAndUpdateStreak(tx, userId, brickId);
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, message: err.message });
  }

  const state = await getViewState(brickId, userId);
  res.json({ success: true, data: state });
}

module.exports = { submit };
