'use strict';

const { evaluate } = require('../../../../src/services/challenges/ImpossibilityValidator');

// Minimal in-memory fake repos. The validator depends on injected readers
// only — never touches the DB directly. Each test sets the relevant repo
// outputs explicitly so we know exactly which filter is triggering.
function makeRepos(overrides = {}) {
  return {
    isContributionEnabled: jest.fn(async () => false),
    countStaleBricks: jest.fn(async () => 1000), // plenty available by default
    countUnmasteredCategories: jest.fn(async () => 50),
    countSessionRemainingForToday: jest.fn(async () => 18), // both sessions available
    isAlreadyFulfilled: jest.fn(async () => false),
    ...overrides,
  };
}

function makeTemplate(overrides = {}) {
  return {
    id: 1n,
    code: 'vote_5_any',
    challenge_family: 'vote',
    scope: 'daily',
    difficulty_band_min: 1,
    difficulty_band_max: 99,
    eligible_lifecycle_states: ['pre_activated', 'active', 'dormant', 'elite'],
    requires_contribution_access: false,
    requires_stale_targets: false,
    requires_category_target: false,
    requires_session_target: false,
    time_window: null,
    target_count: 5,
    logic_definition: { trigger: 'vote_event', match: {} },
    ...overrides,
  };
}

function makeUserCtx(overrides = {}) {
  return {
    userId: 42n,
    localDayKey: '2026-05-18',
    timezone: 'UTC',
    lifecycleState: 'active',
    level: 5,
    nowUtc: new Date('2026-05-18T10:00:00Z'), // 10:00 UTC, mid-day
    ...overrides,
  };
}

describe('ImpossibilityValidator.evaluate — filter rules per Q4', () => {
  test('default happy path returns satisfiable=true', async () => {
    const out = await evaluate(makeTemplate(), makeUserCtx(), makeRepos());
    expect(out.satisfiable).toBe(true);
  });

  describe('time_window filter', () => {
    test('rejects when current local hour is past end_hour', async () => {
      const t = makeTemplate({ time_window: { start_hour: 5, end_hour: 15 } });
      // 16:00 UTC, UTC timezone → past 15:00 cutoff
      const u = makeUserCtx({ nowUtc: new Date('2026-05-18T16:00:00Z'), timezone: 'UTC' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('time_window_unavailable');
    });

    test('allows when within window', async () => {
      const t = makeTemplate({ time_window: { start_hour: 5, end_hour: 15 } });
      const u = makeUserCtx({ nowUtc: new Date('2026-05-18T10:00:00Z'), timezone: 'UTC' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(true);
    });

    test('rejects when before start_hour', async () => {
      const t = makeTemplate({ time_window: { start_hour: 17, end_hour: 23 } });
      const u = makeUserCtx({ nowUtc: new Date('2026-05-18T10:00:00Z'), timezone: 'UTC' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('time_window_unavailable');
    });

    test('respects user timezone for window math', async () => {
      const t = makeTemplate({ time_window: { start_hour: 5, end_hour: 15 } });
      // 20:00 UTC, Asia/Tokyo (UTC+9) = 05:00 next day — within window
      const u = makeUserCtx({ nowUtc: new Date('2026-05-18T20:00:00Z'), timezone: 'Asia/Tokyo' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(true);
    });
  });

  describe('lifecycle filter', () => {
    test('rejects when lifecycle not in eligible list', async () => {
      const t = makeTemplate({ eligible_lifecycle_states: ['elite'] });
      const u = makeUserCtx({ lifecycleState: 'active' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('lifecycle_ineligible');
    });

    test('accepts when lifecycle matches', async () => {
      const t = makeTemplate({ eligible_lifecycle_states: ['active', 'elite'] });
      const u = makeUserCtx({ lifecycleState: 'active' });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(true);
    });
  });

  describe('difficulty band filter', () => {
    test('rejects when level below band', async () => {
      const t = makeTemplate({ difficulty_band_min: 10 });
      const u = makeUserCtx({ level: 5 });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('difficulty_band_ineligible');
    });

    test('rejects when level above band', async () => {
      const t = makeTemplate({ difficulty_band_min: 1, difficulty_band_max: 3 });
      const u = makeUserCtx({ level: 10 });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(false);
    });

    test('accepts boundary values inclusive', async () => {
      const t = makeTemplate({ difficulty_band_min: 5, difficulty_band_max: 5 });
      const u = makeUserCtx({ level: 5 });
      const out = await evaluate(t, u, makeRepos());
      expect(out.satisfiable).toBe(true);
    });
  });

  describe('contribution gate (the M3c feature flag)', () => {
    test('rejects contribute family when feature flag is false', async () => {
      const t = makeTemplate({
        challenge_family: 'contribute',
        requires_contribution_access: true,
      });
      const repos = makeRepos({ isContributionEnabled: jest.fn(async () => false) });
      const out = await evaluate(t, makeUserCtx(), repos);
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('contribution_system_disabled');
    });

    test('accepts contribute family when feature flag flipped on', async () => {
      const t = makeTemplate({
        challenge_family: 'contribute',
        requires_contribution_access: true,
      });
      const repos = makeRepos({ isContributionEnabled: jest.fn(async () => true) });
      const out = await evaluate(t, makeUserCtx(), repos);
      expect(out.satisfiable).toBe(true);
    });

    test('does not call isContributionEnabled when template does not require it', async () => {
      const t = makeTemplate({ requires_contribution_access: false });
      const repos = makeRepos();
      await evaluate(t, makeUserCtx(), repos);
      expect(repos.isContributionEnabled).not.toHaveBeenCalled();
    });
  });

  describe('stale targets filter', () => {
    test('rejects when no stale bricks exist', async () => {
      const t = makeTemplate({ requires_stale_targets: true });
      const repos = makeRepos({ countStaleBricks: jest.fn(async () => 0) });
      const out = await evaluate(t, makeUserCtx(), repos);
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('no_stale_targets');
    });

    test('accepts when stale bricks available', async () => {
      const t = makeTemplate({ requires_stale_targets: true });
      const repos = makeRepos({ countStaleBricks: jest.fn(async () => 5) });
      const out = await evaluate(t, makeUserCtx(), repos);
      expect(out.satisfiable).toBe(true);
    });
  });

  describe('already fulfilled filter', () => {
    test('rejects if condition already met before assignment', async () => {
      const t = makeTemplate();
      const repos = makeRepos({ isAlreadyFulfilled: jest.fn(async () => true) });
      const out = await evaluate(t, makeUserCtx(), repos);
      expect(out.satisfiable).toBe(false);
      expect(out.reason).toBe('already_fulfilled');
    });
  });

  test('filters apply in order — time window short-circuits before lifecycle', async () => {
    const t = makeTemplate({
      time_window: { start_hour: 5, end_hour: 10 },
      eligible_lifecycle_states: ['elite'],
    });
    const u = makeUserCtx({
      nowUtc: new Date('2026-05-18T12:00:00Z'), // past window
      lifecycleState: 'active', // would also fail lifecycle
    });
    const out = await evaluate(t, u, makeRepos());
    expect(out.satisfiable).toBe(false);
    expect(out.reason).toBe('time_window_unavailable'); // not lifecycle
  });
});
