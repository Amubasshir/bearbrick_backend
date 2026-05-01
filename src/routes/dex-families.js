const express = require("express");
const router = express.Router();
const optionalAuth = require("../middleware/optionalAuth");
const DexFamilyController = require("../controllers/dex/DexFamilyController");

// Families (public)
router.get("/dex/families", DexFamilyController.list);
router.get("/dex/families/:slug/bricks", optionalAuth, DexFamilyController.bricks);

module.exports = router;
