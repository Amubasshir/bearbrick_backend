'use strict';

// moneyMath — the ONLY sanctioned arithmetic on money values (Global Rule 11).
// All money in this platform is integer cents. No floating-point dollars ever.
// Every helper validates that its inputs are safe integers and throws loudly on
// a float / NaN / non-number so a bad value can never silently corrupt a balance.

/**
 * Assert `value` is a safe integer number of cents. Throws otherwise.
 * `label` is used in the error message to make the offending call obvious.
 */
function assertCents(value, label = 'value') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`moneyMath: ${label} must be an integer number of cents, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`moneyMath: ${label} exceeds safe integer range`);
  }
  return value;
}

/**
 * Sum any number of cent amounts. Each is validated. Returns an integer.
 */
function add(...amounts) {
  return amounts.reduce((acc, a, i) => acc + assertCents(a, `amount[${i}]`), 0);
}

/**
 * a - b, both validated. Returns an integer (may be negative — callers that
 * require non-negativity check the result themselves).
 */
function subtract(a, b) {
  return assertCents(a, 'a') - assertCents(b, 'b');
}

/**
 * Derived available cash = cash_balance_cents - reserved_cash_cents.
 * Never stored; always computed from the two balance columns.
 */
function availableCash(cashBalanceCents, reservedCashCents) {
  return subtract(cashBalanceCents, reservedCashCents);
}

/**
 * Integer-only display formatting ("$12.50", "-$0.07"). For UI / logs only —
 * never feed the result back into arithmetic. No floating point used.
 */
function centsToDisplay(cents) {
  assertCents(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${String(remainder).padStart(2, '0')}`;
}

module.exports = {
  assertCents,
  add,
  subtract,
  availableCash,
  centsToDisplay,
};
