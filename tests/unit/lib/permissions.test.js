'use strict';

// Pure unit tests for permissions.hasRole. For this milestone every admin-tier
// role resolves to the is_admin boolean (D1); accepts both camelCase (Prisma)
// and snake_case (raw SQL) user shapes.

const { hasRole, hasPermission, isAdminFlag } = require('../../../src/lib/permissions');

// The 14 canonical permission flags from the login/admin spec (E0.5). Every
// flag resolves against is_admin for now (Phase B); the primitive keeps a
// forward-compatible (user, flag) signature for the future role engine.
const ALL_FLAGS = [
  'can_vote', 'can_audit', 'can_submit_images', 'can_approve_images',
  'can_edit_bricks', 'can_moderate_profiles', 'can_moderate_comments',
  'can_issue_readonly', 'can_suspend_users', 'can_recommend_ban',
  'can_ban_users', 'can_view_logs', 'can_manage_roles', 'can_manage_settings',
];

describe('lib/permissions — isAdminFlag', () => {
  test('reads camelCase isAdmin', () => {
    expect(isAdminFlag({ isAdmin: true })).toBe(true);
    expect(isAdminFlag({ isAdmin: false })).toBe(false);
  });
  test('reads snake_case is_admin', () => {
    expect(isAdminFlag({ is_admin: true })).toBe(true);
    expect(isAdminFlag({ is_admin: false })).toBe(false);
  });
  test('false for missing flag / null user', () => {
    expect(isAdminFlag({})).toBe(false);
    expect(isAdminFlag(null)).toBe(false);
  });
  test('only strict true counts (not truthy values)', () => {
    expect(isAdminFlag({ isAdmin: 1 })).toBe(false);
    expect(isAdminFlag({ isAdmin: 'yes' })).toBe(false);
  });
});

describe('lib/permissions — hasRole', () => {
  test('admin user satisfies admin and super_admin', () => {
    const admin = { id: 1n, isAdmin: true };
    expect(hasRole(admin, 'admin')).toBe(true);
    expect(hasRole(admin, 'super_admin')).toBe(true);
    expect(hasRole(admin, ['admin', 'super_admin'])).toBe(true);
  });

  test('non-admin user fails admin checks', () => {
    const user = { id: 2n, isAdmin: false };
    expect(hasRole(user, 'admin')).toBe(false);
    expect(hasRole(user, 'super_admin')).toBe(false);
  });

  test('snake_case admin row is accepted', () => {
    expect(hasRole({ id: 3, is_admin: true }, 'admin')).toBe(true);
  });

  test('null user is never authorized', () => {
    expect(hasRole(null, 'admin')).toBe(false);
    expect(hasRole(undefined, 'admin')).toBe(false);
  });

  test('unknown / non-admin roles return false (auth milestone deferred)', () => {
    expect(hasRole({ isAdmin: true }, 'moderator')).toBe(false);
    expect(hasRole({ isAdmin: true }, 'user')).toBe(false);
  });
});

describe('lib/permissions — hasPermission', () => {
  test('admin user (camelCase) satisfies every one of the 14 flags', () => {
    const admin = { id: 1n, isAdmin: true };
    for (const flag of ALL_FLAGS) {
      expect(hasPermission(admin, flag)).toBe(true);
    }
  });

  test('admin user (snake_case raw row) satisfies every one of the 14 flags', () => {
    const admin = { id: 1, is_admin: true };
    for (const flag of ALL_FLAGS) {
      expect(hasPermission(admin, flag)).toBe(true);
    }
  });

  test('non-admin user is denied every one of the 14 flags', () => {
    const user = { id: 2n, isAdmin: false };
    for (const flag of ALL_FLAGS) {
      expect(hasPermission(user, flag)).toBe(false);
    }
  });

  test('null user → false, strict, for every flag (pins the option-2 split)', () => {
    for (const flag of ALL_FLAGS) {
      expect(hasPermission(null, flag)).toBe(false);
    }
  });

  test('undefined user → false for every flag', () => {
    for (const flag of ALL_FLAGS) {
      expect(hasPermission(undefined, flag)).toBe(false);
    }
  });

  test('only strict is_admin===true authorizes (truthy values do not)', () => {
    expect(hasPermission({ isAdmin: 1 }, 'can_edit_bricks')).toBe(false);
    expect(hasPermission({ isAdmin: 'yes' }, 'can_edit_bricks')).toBe(false);
  });

  test('a representative flag: admin true, non-admin false', () => {
    expect(hasPermission({ isAdmin: true }, 'can_approve_images')).toBe(true);
    expect(hasPermission({ isAdmin: false }, 'can_approve_images')).toBe(false);
  });
});
