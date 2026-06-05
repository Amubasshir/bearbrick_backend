'use strict';

const prisma = require('../../../src/lib/prisma');
const Svc = require('../../../src/services/bounties/BountyDefinitionService');

describe('BountyDefinitionService (DB)', () => {
  test('listActive returns the 8 seeded types with HIGH ordered first', async () => {
    const defs = await Svc.listActive(prisma);
    const types = defs.map((d) => d.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'PACKAGING_FRONT', 'PACKAGING_BACK', 'BACK_OF_FIGURE', 'SIDE_VIEW',
        'BOTTOM_STAMP', 'RELEASE_YEAR', 'RELEASE_METHOD', 'NOTES_CONTEXT',
      ])
    );
    expect(defs[0].priority).toBe('HIGH');
  });

  test('getByType returns the captured reward amounts from the spec table', async () => {
    expect(await Svc.getByType(prisma, 'PACKAGING_BACK')).toMatchObject({
      reward_cash_cents: 75, reward_credits: 75, priority: 'HIGH',
    });
    expect(await Svc.getByType(prisma, 'RELEASE_YEAR')).toMatchObject({
      reward_cash_cents: 15, reward_credits: 15, priority: 'MEDIUM',
    });
    expect(await Svc.getByType(prisma, 'NOPE')).toBeNull();
  });

  test('getAdminSettings parses seeded config into typed fields', async () => {
    const s = await Svc.getAdminSettings(prisma);
    expect(s.monthlyCashBudgetCents).toBe(50000);
    expect(s.cashRewardsEnabled).toBe(true);
    expect(s.minimumPayoutCents).toBe(1000);
    // spent is mutated by approval tests in later sub-phases; just assert shape.
    expect(typeof s.monthlyCashSpentCents).toBe('number');
    expect(s.monthlyCashSpentCents).toBeGreaterThanOrEqual(0);
  });
});
