'use strict';

// permissions — admin authority check for the bounty milestone.
//
// Decision D1 (minimal): the dedicated auth milestone (role enum + the 14
// permission flags) is deferred. For now admin authority is the existing
// `is_admin` boolean on "User". hasRole keeps a forward-compatible signature so
// the future auth milestone can extend it to branch on users.role / overrides
// without changing call sites.
//
// User objects reach here from two sources: the Prisma client (camelCase
// `isAdmin`) and raw SQL rows (snake_case `is_admin`). Both are accepted.

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

// The 14 canonical permission flags (login/admin spec E0.5). This is the full
// set hasPermission accepts. For this phase every flag resolves against the
// is_admin boolean; the real role engine will later map role -> flags without
// changing any call site.
const PERMISSION_FLAGS = new Set([
  'can_vote', 'can_audit', 'can_submit_images', 'can_approve_images',
  'can_edit_bricks', 'can_moderate_profiles', 'can_moderate_comments',
  'can_issue_readonly', 'can_suspend_users', 'can_recommend_ban',
  'can_ban_users', 'can_view_logs', 'can_manage_roles', 'can_manage_settings',
]);

/**
 * Read the is_admin flag from a user object regardless of casing source.
 */
function isAdminFlag(user) {
  if (!user) return false;
  const flag = user.isAdmin !== undefined ? user.isAdmin : user.is_admin;
  return flag === true;
}

/**
 * Does `user` satisfy the required role (string or array of strings)?
 * For this milestone every admin-tier role resolves to the is_admin boolean.
 * Returns false for unknown / non-admin roles until the auth milestone lands.
 */
function hasRole(user, role) {
  if (!user) return false;
  const roles = Array.isArray(role) ? role : [role];
  if (roles.some((r) => ADMIN_ROLES.has(r))) {
    return isAdminFlag(user);
  }
  return false;
}

/**
 * Does `user` hold permission `flag`? Pure function of (user, flag).
 * `null`/`undefined` user → false, always (the transport-layer X-Admin-Secret
 * bypass lives above this in adminAuth and never reaches here). For this phase
 * every one of the 14 canonical flags resolves to the is_admin boolean; unknown
 * flags deny by default. Signature is forward-compatible for the real role
 * engine — call sites never change.
 */
function hasPermission(user, flag) {
  if (!user) return false;
  if (!PERMISSION_FLAGS.has(flag)) return false;
  return isAdminFlag(user);
}

module.exports = {
  hasRole,
  hasPermission,
  isAdminFlag,
  ADMIN_ROLES,
  PERMISSION_FLAGS,
};
