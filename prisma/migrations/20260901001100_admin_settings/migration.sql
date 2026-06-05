-- M4 Migration 11: admin_settings (+ seed of MVP keys)
-- Per spec section 17.8. Simple key/value config (TEXT values, parsed by
-- moneyMath / BountyDefinitionService). MVP keys seeded with their default
-- values. monthly_budget_last_reset_period is an extra marker used by the
-- monthly-budget-reset-worker to make the monthly reset idempotent (YYYY-MM).

CREATE TABLE admin_settings (
  key        TEXT         PRIMARY KEY,
  value      TEXT         NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO admin_settings (key, value) VALUES
  ('monthly_cash_budget_cents',        '50000'),
  ('monthly_cash_spent_cents',         '0'),
  ('cash_rewards_enabled',             'true'),
  ('minimum_payout_cents',             '1000'),
  ('monthly_budget_last_reset_period', '')
ON CONFLICT (key) DO NOTHING;
