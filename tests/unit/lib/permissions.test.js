'use strict';

// Pure unit tests for permissions.hasRole. For this milestone every admin-tier
// role resolves to the is_admin boolean (D1); accepts both camelCase (Prisma)
// and snake_case (raw SQL) user shapes.

const { hasRole, isAdminFlag } = require('../../../src/lib/permissions');

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
