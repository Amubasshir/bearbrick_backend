/**
 * DexVoteController
 *   POST /dex/bricks/:id/vote — Stage 2 vote (requires stage >= 1, idempotent)
 *
 * Atomically:
 *   1. Validate eligibility (stage >= 1, not yet voted)
 *   2. Create VoteIntent (pricing engine picks it up async)
 *   3. Advance stage to 2 (with voteType stored) — logs STAGE_ADVANCED to DexEventLog
 *   4. Award XP (reason: VOTE, amount: 10)
 *   5. Log VOTE_SUBMITTED to DexEventLog
 *   6. Update daily streak
 *   7. Return BrickViewState
 */
const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { getViewState } = require("../../services/dex/BrickViewStateService");
const { getOrCreateProgress, advanceStage } = require("../../services/dex/DexProgressService");
const { checkAndUpdateStreak } = require("../../services/dex/XpService");

const VOTE_XP = 10;

async function vote(req, res) {
  const { id: brickId } = req.params;
  const userId = req.user.id;
  const { vote_type } = req.body;

  if (!["UNDER", "FAIR", "OVER"].includes(vote_type)) {
    return res.status(422).json({
      success: false,
      message: "vote_type must be UNDER, FAIR, or OVER.",
    });
  }

  const brick = await prisma.brick.findUnique({ where: { id: brickId } });
  if (!brick) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const progress = await getOrCreateProgress(tx, userId, brickId);

      if (progress.stage < 1) {
        const err = new Error("Must complete context first.");
        err.statusCode = 403;
        throw err;
      }
      if (progress.stage >= 2) {
        const err = new Error("Already voted on this brick.");
        err.statusCode = 409;
        throw err;
      }

      // Create VoteIntent for the pricing engine
      const ipHash = crypto
        .createHash("sha256")
        .update(req.ip || "127.0.0.1")
        .digest("hex");

      await tx.voteIntent.create({
        data: {
          userId,
          brickId,
          voteType: vote_type,
          ipHash,
          userAgent: req.get("user-agent") || null,
          sessionId: req.headers["x-session-id"] || null,
          status: "PENDING",
        },
      });

      // Advance stage to 2 (also logs STAGE_ADVANCED)
      await advanceStage(tx, userId, brickId, 2, { voteType: vote_type });

      // Award XP
      await tx.xpEvent.create({
        data: {
          userId,
          brickId,
          xpAmount: VOTE_XP,
          reason: "VOTE",
        },
      });

      // Log vote submission
      await tx.dexEventLog.create({
        data: {
          eventType: "VOTE_SUBMITTED",
          userId,
          brickId,
          payload: { vote_type },
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

module.exports = { vote };
