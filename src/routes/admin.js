const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const idempotency = require("../middleware/idempotency");
const AdminBrickController = require("../controllers/admin/AdminBrickController");

router.post(
  "/admin/bricks",
  adminAuth,
  idempotency({ required: false }),
  AdminBrickController.create
);
router.patch("/admin/bricks/:id", adminAuth, AdminBrickController.update);

module.exports = router;
