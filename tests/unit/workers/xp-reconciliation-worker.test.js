'use strict';

const { resolveLevel, applyEvent } = require('../../../src/scripts/xp-reconciliation-worker');

const LEVEL_DEFS = [
  { level_number: 1,  min_xp: 0,     is_active: true },
  { level_number: 2,  min_xp: 100,   is_active: true },
  { level_number: 3,  min_xp: 250,   is_active: true },
  { level_number: 4,  min_xp: 500,   is_active: true },
  { level_number: 5,  min_xp: 1000,  is_active: true },
  { level_number: 6,  min_xp: 2000,  is_active: true },
  { level_number: 7,  min_xp: 3500,  is_active: true },
  { level_number: 8,  min_xp: 5000,  is_active: true },
  { level_number: 9,  min_xp: 7500,  is_active: true },
  { level_number: 10, min_xp: 10000, is_active: true },
];

function makeState(overrides = {}) {
  return {
    total_xp_confirmed: 0,
    current_level: 1,
    highest_level_ever: 1,
    last_reconciled_xp_event_id: BigInt(0),
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    id: BigInt(1),
    xp_delta_signed: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveLevel
// ---------------------------------------------------------------------------
describe('resolveLevel', () => {
  test('returns 1 for 0 XP', () => {
    expect(resolveLevel(0, LEVEL_DEFS)).toBe(1);
  });

  test('returns 1 for 99 XP (below level 2 threshold)', () => {
    expect(resolveLevel(99, LEVEL_DEFS)).toBe(1);
  });

  test('returns 2 for exactly 100 XP', () => {
    expect(resolveLevel(100, LEVEL_DEFS)).toBe(2);
  });

  test('returns 2 for 249 XP', () => {
    expect(resolveLevel(249, LEVEL_DEFS)).toBe(2);
  });

  test('returns 3 for exactly 250 XP', () => {
    expect(resolveLevel(250, LEVEL_DEFS)).toBe(3);
  });

  test('returns 10 for 10000 XP', () => {
    expect(resolveLevel(10000, LEVEL_DEFS)).toBe(10);
  });

  test('returns 10 for 99999 XP (capped at max defined level)', () => {
    expect(resolveLevel(99999, LEVEL_DEFS)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// applyEvent — XP accumulation
// ---------------------------------------------------------------------------
describe('applyEvent — accumulation', () => {
  test('increases total_xp_confirmed by xp_delta_signed', () => {
    const state = makeState({ total_xp_confirmed: 50 });
    const event = makeEvent({ id: BigInt(5), xp_delta_signed: 30 });
    const { newState } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.total_xp_confirmed).toBe(80);
  });

  test('updates last_reconciled_xp_event_id to event.id', () => {
    const state = makeState();
    const event = makeEvent({ id: BigInt(42), xp_delta_signed: 10 });
    const { newState } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.last_reconciled_xp_event_id).toBe(BigInt(42));
  });
});

// ---------------------------------------------------------------------------
// applyEvent — level-up detection
// ---------------------------------------------------------------------------
describe('applyEvent — level-up detection', () => {
  test('emits levelUpEvent when crossing a level threshold (level 1 → 2)', () => {
    const state = makeState({ total_xp_confirmed: 90, current_level: 1, highest_level_ever: 1 });
    const event = makeEvent({ id: BigInt(10), xp_delta_signed: 10 }); // 90+10=100 → level 2
    const { levelUpEvent } = applyEvent(state, event, LEVEL_DEFS);
    expect(levelUpEvent).not.toBeNull();
    expect(levelUpEvent.to_level).toBe(2);
  });

  test('levelUpEvent has correct from_level, to_level, triggered_by_xp_event_id', () => {
    const state = makeState({ total_xp_confirmed: 90, current_level: 1, highest_level_ever: 1 });
    const event = makeEvent({ id: BigInt(7), xp_delta_signed: 10 });
    const { levelUpEvent } = applyEvent(state, event, LEVEL_DEFS);
    expect(levelUpEvent.from_level).toBe(1);
    expect(levelUpEvent.to_level).toBe(2);
    expect(levelUpEvent.triggered_by_xp_event_id).toBe(BigInt(7));
  });

  test('does NOT emit levelUpEvent when staying within the same level band', () => {
    const state = makeState({ total_xp_confirmed: 50, current_level: 1, highest_level_ever: 1 });
    const event = makeEvent({ id: BigInt(3), xp_delta_signed: 10 }); // 50+10=60, still level 1
    const { levelUpEvent } = applyEvent(state, event, LEVEL_DEFS);
    expect(levelUpEvent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyEvent — no level downgrade (hard rule)
// ---------------------------------------------------------------------------
describe('applyEvent — no level downgrade', () => {
  test('current_level does NOT decrease when xp_delta_signed is negative', () => {
    const state = makeState({ total_xp_confirmed: 150, current_level: 2, highest_level_ever: 2 });
    const event = makeEvent({ id: BigInt(11), xp_delta_signed: -100 }); // drops to 50 XP (level 1 band)
    const { newState } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.current_level).toBe(2);
  });

  test('total_xp_confirmed CAN go below previous level threshold — level stays', () => {
    const state = makeState({ total_xp_confirmed: 150, current_level: 2, highest_level_ever: 2 });
    const event = makeEvent({ id: BigInt(12), xp_delta_signed: -100 }); // total becomes 50
    const { newState } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.total_xp_confirmed).toBe(50);
    expect(newState.current_level).toBe(2);
  });

  test('highest_level_ever is preserved and never decreases', () => {
    const state = makeState({ total_xp_confirmed: 150, current_level: 2, highest_level_ever: 2 });
    const event = makeEvent({ id: BigInt(13), xp_delta_signed: -100 });
    const { newState } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.highest_level_ever).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyEvent — multi-level skip
// ---------------------------------------------------------------------------
describe('applyEvent — multi-level skip', () => {
  test('single event pushing level 1 → 3 emits ONE level_up_event with to_level: 3', () => {
    const state = makeState({ total_xp_confirmed: 0, current_level: 1, highest_level_ever: 1 });
    const event = makeEvent({ id: BigInt(20), xp_delta_signed: 300 }); // 0+300=300 → level 3
    const { newState, levelUpEvent } = applyEvent(state, event, LEVEL_DEFS);
    expect(newState.current_level).toBe(3);
    expect(levelUpEvent).not.toBeNull();
    expect(levelUpEvent.from_level).toBe(1);
    expect(levelUpEvent.to_level).toBe(3);
  });
});
