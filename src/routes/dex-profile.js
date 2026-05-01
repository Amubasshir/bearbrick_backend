const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const DexProfileController = require("../controllers/dex/DexProfileController");
const DexLeaderboardController = require("../controllers/dex/DexLeaderboardController");
const DexStatsService = require("../services/dex/DexStatsService");

// User profile & progress (auth required)
router.get("/dex/me", auth, DexProfileController.getProfile);
router.get("/dex/me/xp", auth, DexProfileController.getXp);
router.get("/dex/me/stats", auth, DexProfileController.getStats);
router.get("/dex/me/progress", auth, DexProfileController.getProgress);

// Public stats
router.get("/dex/stats/global", async (req, res) => {
  const data = await DexStatsService.getGlobalStats();
  res.json({ success: true, data });
});

// Leaderboards (public)
router.get("/dex/leaderboard/xp", DexLeaderboardController.xpLeaderboard);
router.get("/dex/leaderboard/completion", DexLeaderboardController.completionLeaderboard);

module.exports = router;
