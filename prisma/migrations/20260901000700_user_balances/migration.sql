-- M4 Migration 7: user_balances
-- Per spec section 17.4. One row per user, created on signup (Q12 / D3).
-- Cents-only money. available_cash is DERIVED (cash_balance_cents -
-- reserved_cash_cents) and never stored. CHECK constraints keep every money
-- column non-negative so an over-decrement can never silently corrupt a balance.

CREATE TABLE user_balances (
  user_id                     BIGINT       PRIMARY KEY REFERENCES "User"(id),
  cash_balance_cents          INTEGER      NOT NULL DEFAULT 0,
  reserved_cash_cents         INTEGER      NOT NULL DEFAULT 0,
  credit_balance              INTEGER      NOT NULL DEFAULT 0,
  lifetime_cash_earned_cents  INTEGER      NOT NULL DEFAULT 0,
  lifetime_credits_earned     INTEGER      NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT user_balances_cash_nonneg     CHECK (cash_balance_cents >= 0),
  CONSTRAINT user_balances_reserved_nonneg CHECK (reserved_cash_cents >= 0),
  CONSTRAINT user_balances_credit_nonneg   CHECK (credit_balance >= 0),
  CONSTRAINT user_balances_ltcash_nonneg   CHECK (lifetime_cash_earned_cents >= 0),
  CONSTRAINT user_balances_ltcredit_nonneg CHECK (lifetime_credits_earned >= 0)
);
