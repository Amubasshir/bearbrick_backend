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

module.exports = {
  hasRole,
  isAdminFlag,
  ADMIN_ROLES,
};
