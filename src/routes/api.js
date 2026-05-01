const express = require("express");
const router = express.Router();
const AuthController = require("../controllers/AuthController");
const VoteIntentController = require("../controllers/VoteIntentController");
const BrickController = require("../controllers/BrickController");
const RecheckController = require("../controllers/RecheckController");
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const rateLimitVoteIntents = require("../middleware/rateLimitVoteIntents");

router.post("/signup", AuthController.signup);
router.post("/login", AuthController.login);
router.post("/logout", auth, AuthController.logout);
router.get("/me", auth, AuthController.me);

router.post(
  "/vote_intents",
  auth,
  rateLimitVoteIntents,
  VoteIntentController.store
);
router.get("/bricks", optionalAuth, BrickController.getAllBricks);
router.get("/bricks/:brick_id/state", optionalAuth, BrickController.getState);
router.get("/recheck/feed", auth, RecheckController.getFeed);

module.exports = router;
