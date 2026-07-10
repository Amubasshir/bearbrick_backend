const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const requirePermission = require('../middleware/requirePermission');
const AdminBountyController = require('../controllers/admin/AdminBountyController');

// Admin bounty endpoints. Every route composes adminAuth (transport) +
// requirePermission(flag) (permission), the option-2 template all admin bounty
// units reuse.
router.get(
  '/admin/bounty-submissions',
  adminAuth,
  requirePermission('can_approve_images'),
  AdminBountyController.submissionQueue
);

router.post(
  '/admin/bounty-submissions/:id/approve',
  adminAuth,
  requirePermission('can_approve_images'),
  AdminBountyController.approve
);

router.post(
  '/admin/bounty-submissions/:id/approve-without-applying',
  adminAuth,
  requirePermission('can_approve_images'),
  AdminBountyController.approveWithoutApplying
);

router.post(
  '/admin/bounty-submissions/:id/approve-and-apply',
  adminAuth,
  requirePermission('can_edit_bricks'),
  AdminBountyController.approveAndApply
);

router.post(
  '/admin/bounty-submissions/:id/reject',
  adminAuth,
  requirePermission('can_approve_images'),
  AdminBountyController.reject
);

// Management endpoints (Group B4). Manual bounty creation is a brick-domain write.
router.post(
  '/admin/bounties',
  adminAuth,
  requirePermission('can_edit_bricks'),
  AdminBountyController.createBounty
);

// Reward amounts + global type pause are system config (can_manage_settings).
router.patch(
  '/admin/bounty-definitions/:id',
  adminAuth,
  requirePermission('can_manage_settings'),
  AdminBountyController.updateDefinition
);

// Pause/close/reopen a specific instance is a brick-domain write (can_edit_bricks).
router.patch(
  '/admin/bounty-instances/:id',
  adminAuth,
  requirePermission('can_edit_bricks'),
  AdminBountyController.updateInstance
);

// Payout administration is money/config (can_manage_settings).
router.get(
  '/admin/payout-requests',
  adminAuth,
  requirePermission('can_manage_settings'),
  AdminBountyController.payoutQueue
);

router.patch(
  '/admin/payout-requests/:id',
  adminAuth,
  requirePermission('can_manage_settings'),
  AdminBountyController.updatePayout
);

module.exports = router;
