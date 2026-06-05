'use strict';

const { evaluate } = require('../../../../src/services/bounties/BountyEligibilityService');

describe('bounties/BountyEligibilityService — evaluate (pure)', () => {
  test('active user is eligible', () => {
    expect(evaluate({ account_state: 'active' })).toEqual({ eligible: true, reason: null });
  });

  test('null/absent account_state is treated as active (graceful pass-through)', () => {
    expect(evaluate({}).eligible).toBe(true);
    expect(evaluate({ account_state: null }).eligible).toBe(true);
  });

  test('blocks read_only / suspended / banned', () => {
    expect(evaluate({ account_state: 'read_only' })).toEqual({ eligible: false, reason: 'account_read_only' });
    expect(evaluate({ account_state: 'suspended_temporary' }).eligible).toBe(false);
    expect(evaluate({ account_state: 'banned_permanent' }).eligible).toBe(false);
  });

  test('email verification gate applies only when required (IMAGE)', () => {
    const unverified = { account_state: 'active', email_verified_at: null };
    expect(evaluate(unverified, { requiresEmailVerification: true }))
      .toEqual({ eligible: false, reason: 'email_not_verified' });
    // Not required (DATA submission) -> still eligible.
    expect(evaluate(unverified, { requiresEmailVerification: false }).eligible).toBe(true);
  });

  test('verified email passes the IMAGE gate', () => {
    const verified = { account_state: 'active', email_verified_at: new Date() };
    expect(evaluate(verified, { requiresEmailVerification: true }).eligible).toBe(true);
  });

  test('accepts camelCase user shape', () => {
    expect(evaluate({ accountState: 'banned_permanent' }).eligible).toBe(false);
    expect(evaluate({ accountState: 'active', emailVerifiedAt: null }, { requiresEmailVerification: true }).reason)
      .toBe('email_not_verified');
  });

  test('null user is not eligible', () => {
    expect(evaluate(null)).toEqual({ eligible: false, reason: 'user_not_found' });
  });
});
