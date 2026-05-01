const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const idempotency = require("../middleware/idempotency");
const DexBrickController = require("../controllers/dex/DexBrickController");
const DexContextController = require("../controllers/dex/DexContextController");
const DexVoteController = require("../controllers/dex/DexVoteController");
const DexValueDriverController = require("../controllers/dex/DexValueDriverController");
const DexValueDriverOptionsController = require("../controllers/dex/DexValueDriverOptionsController");
const DexStatsService = require("../services/dex/DexStatsService");

// Catalogue — /dex/bricks/featured must come before /dex/bricks/:id
router.get("/dex/bricks/featured", optionalAuth, (req, res, next) => {
  req.query.featured = "true";
  return DexBrickController.list(req, res, next);
});
router.get("/dex/bricks", optionalAuth, DexBrickController.list);
router.get("/dex/bricks/:id", optionalAuth, DexBrickController.detail);
router.get("/dex/search", optionalAuth, DexBrickController.search);

// Stage 1 — context
router.post("/dex/bricks/:id/context/open", optionalAuth, DexContextController.open);
router.post(
  "/dex/bricks/:id/context/progress",
  auth,
  idempotency({ required: true }),
  DexContextController.progress
);

// Stage 2 — vote
router.post(
  "/dex/bricks/:id/vote",
  auth,
  idempotency({ required: true }),
  DexVoteController.vote
);

// Stage 3 — value driver
router.post(
  "/dex/bricks/:id/value-driver",
  auth,
  idempotency({ required: true }),
  DexValueDriverController.submit
);

// Value driver options catalogue (public)
router.get("/dex/value-driver-options", DexValueDriverOptionsController.list);

// Per-brick stats (public)
router.get("/dex/bricks/:id/stats", async (req, res) => {
  const { id } = req.params;
  const prisma = require("../lib/prisma");
  const brick = await prisma.brick.findUnique({ where: { id }, select: { id: true } });
  if (!brick) return res.status(404).json({ success: false, message: "Brick not found." });
  const data = await DexStatsService.getBrickStats(id);
  res.json({ success: true, data });
});

module.exports = router;
