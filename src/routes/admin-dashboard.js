const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const idempotency = require("../middleware/idempotency");
const AdminDashboardController = require("../controllers/admin/AdminDashboardController");
const AdminFamilyController = require("../controllers/admin/AdminFamilyController");
const AdminValueDriverOptionController = require("../controllers/admin/AdminValueDriverOptionController");

// Admin dashboard — brick list with stats
router.get("/admin/bricks", adminAuth, AdminDashboardController.listBricks);

// Admin dashboard — user list with XP + completion
router.get("/admin/users", adminAuth, AdminDashboardController.listUsers);

// Bulk status update (must come before :id routes to avoid route collision)
router.post(
  "/admin/bricks/bulk-status",
  adminAuth,
  idempotency({ required: false }),
  AdminDashboardController.bulkStatus
);

// Feature toggle
router.patch("/admin/bricks/:id/feature", adminAuth, AdminDashboardController.featureBrick);

// Brick event log
router.get("/admin/bricks/:id/event-log", adminAuth, AdminDashboardController.getBrickEventLog);

// Brick families
router.post(
  "/admin/families",
  adminAuth,
  idempotency({ required: false }),
  AdminFamilyController.create
);
router.patch("/admin/families/:id", adminAuth, AdminFamilyController.update);

// Value driver options
router.post(
  "/admin/value-driver-options",
  adminAuth,
  idempotency({ required: false }),
  AdminValueDriverOptionController.create
);
router.delete("/admin/value-driver-options/:id", adminAuth, AdminValueDriverOptionController.remove);

module.exports = router;
