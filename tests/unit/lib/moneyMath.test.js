'use strict';

// Pure unit tests for moneyMath. Cents-only integer arithmetic; every helper
// must reject non-integer / unsafe input so a bad money value never propagates.

const {
  assertCents,
  add,
  subtract,
  availableCash,
  centsToDisplay,
} = require('../../../src/lib/moneyMath');

describe('lib/moneyMath — assertCents', () => {
  test('accepts and returns a valid integer', () => {
    expect(assertCents(0)).toBe(0);
    expect(assertCents(1250)).toBe(1250);
    expect(assertCents(-50)).toBe(-50);
  });

  test('rejects floats (no floating-point dollars)', () => {
    expect(() => assertCents(12.5)).toThrow(/integer number of cents/);
    expect(() => assertCents(0.1)).toThrow(/integer number of cents/);
  });

  test('rejects NaN, strings, null, undefined', () => {
    expect(() => assertCents(NaN)).toThrow();
    expect(() => assertCents('100')).toThrow();
    expect(() => assertCents(null)).toThrow();
    expect(() => assertCents(undefined)).toThrow();
  });

  test('rejects unsafe integers', () => {
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
  });

  test('error message includes the supplied label', () => {
    expect(() => assertCents(1.5, 'rewardCashCents')).toThrow(/rewardCashCents/);
  });
});

describe('lib/moneyMath — add', () => {
  test('sums any number of amounts', () => {
    expect(add(50, 75)).toBe(125);
    expect(add(0, 0, 0)).toBe(0);
    expect(add(1000)).toBe(1000);
    expect(add()).toBe(0);
  });

  test('validates every operand', () => {
    expect(() => add(50, 0.5)).toThrow();
    expect(() => add(50, '25')).toThrow();
  });
});

describe('lib/moneyMath — subtract', () => {
  test('subtracts validated integers', () => {
    expect(subtract(2500, 1000)).toBe(1500);
  });

  test('may return a negative result (caller enforces non-negativity)', () => {
    expect(subtract(100, 250)).toBe(-150);
  });

  test('validates operands', () => {
    expect(() => subtract(100, 1.1)).toThrow();
  });
});

describe('lib/moneyMath — availableCash', () => {
  test('cash minus reserved', () => {
    expect(availableCash(2500, 1000)).toBe(1500); // spec §9.5 example
    expect(availableCash(1250, 0)).toBe(1250);
  });

  test('fully reserved leaves zero available', () => {
    expect(availableCash(1000, 1000)).toBe(0);
  });
});

describe('lib/moneyMath — centsToDisplay', () => {
  test('formats whole and fractional dollars', () => {
    expect(centsToDisplay(1250)).toBe('$12.50');
    expect(centsToDisplay(75)).toBe('$0.75');
    expect(centsToDisplay(0)).toBe('$0.00');
    expect(centsToDisplay(100)).toBe('$1.00');
    expect(centsToDisplay(3875)).toBe('$38.75');
  });

  test('pads single-digit cents', () => {
    expect(centsToDisplay(105)).toBe('$1.05');
    expect(centsToDisplay(7)).toBe('$0.07');
  });

  test('handles negatives', () => {
    expect(centsToDisplay(-150)).toBe('-$1.50');
  });

  test('rejects non-integer input', () => {
    expect(() => centsToDisplay(12.5)).toThrow();
  });
});
