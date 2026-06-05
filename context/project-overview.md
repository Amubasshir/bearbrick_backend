# BE@RBRICK Platform — Full Project Overview

## What This File Is

This file is the canonical project context for Claude Code. It covers the full scope of the BE@RBRICK platform across all milestones — what has been built, how it works, what the architecture decisions are, and what is still in progress. Read this before touching any part of the codebase.

---

## Project Summary

**Client:** TheFirstEdition (Jake)
**Platform:** BE@RBRICK Encyclopedia and Collector Platform
**Stack:** Next.js, Supabase (PostgreSQL), background workers
**Design Goal:** A comprehensive web platform for BE@RBRICK collectors featuring crowdsourced market pricing, a full collectible encyclopedia (Dex), gamification via XP and challenges, leaderboards, and eventually AI image recognition.
**Architecture Philosophy:** Event-sourced, deterministic, fully replayable from event logs alone. No business logic in API handlers. All state mutations happen inside workers. State tables are worker-owned and read-only to clients.

---

## Milestone 1 — Crowdsourced Pricing Engine

**Status:** Complete and delivered. Paid.

### Purpose

A sportsbook-style market correction engine where the crowd votes on whether a BE@RBRICK's current price is UNDER, FAIR, or OVER. The engine processes votes, adjusts prices, and resists manipulation and abuse.

### Core Principles (Non-Negotiable)

1. **Blind Voting** — No sentiment, confidence, percentages, thresholds, or caps are visible before a user votes.
2. **Insight Is Earned** — Sentiment and confidence are revealed only after the user votes.
3. **Trust Is Behavioral** — Influence is earned through correctness over time, not activity or tenure.
4. **No Single Actor Can Dominate** — Vote weight is capped, reversible, and risk-aware.
5. **Transparency Without Exploitability** — Users know integrity systems exist but implementation details are never exposed.
6. **Determinism** — All outcomes must be reproducible from event logs alone.

### Voting Model

Users vote exactly one of three options per brick per cycle:

- **UNDER** — price should be below the lower fair range boundary
- **FAIR** — price is fair within the current range
- **OVER** — price should be above the upper fair range boundary

Internal mapping: UNDER = -1, FAIR = 0, OVER = +1. FAIR votes dampen movement but never create it.

### Fair Range

`FAIR_RANGE_PCT = 0.05`
`lower_range = live_price * 0.95`
`upper_range = live_price * 1.05`

Fair range is computed in the worker and logged on every vote event for determinism. It defines vote meaning and anchor boundaries, not step sizing or caps.

### Price Tiers and Base Step

Price movement step sizes scale with the price tier of the brick:

| Price Range         | Base Step |
| ------------------- | --------- |
| $0 to $49.99        | $3        |
| $50 to $99.99       | $5        |
| $100 to $149.99     | $7        |
| $150 to $299.99     | $10       |
| $300 to $499.99     | $15       |
| $500 to $999.99     | $25       |
| $1,000 to $1,999.99 | $40       |
| $2,000+             | $75       |

### Vote Weight System

`final_weight = base_account_age_weight * trust_tier_multiplier * behavior_multiplier`
`final_weight = clamp(final_weight, 0.0, 1.25)`

### Sentiment and Confidence

`weighted_total = weighted_under + weighted_fair + weighted_over`
`p_under = weighted_under / weighted_total`
`p_fair = weighted_fair / weighted_total`
`p_over = weighted_over / weighted_total`

Direction: p_over > p_under = UP, p_under > p_over = DOWN, tie = no movement.

`pricing_confidence_C = min(1.0, weighted_total / 50)`

### Movement Eligibility

Price may only move if ALL are true:

- `weighted_total >= 5`
- `weighted_since_last_move >= 5`
- `freeze_mode == false`

### Anchor-Based Movement

Price never moves from center. It moves from the fair range boundary:

- OVER dominant: `anchor = upper_range`, `new_price = anchor + step`
- UNDER dominant: `anchor = lower_range`, `new_price = anchor - step`

### Intensity and Step Calculation

`intensity = max(p_under, p_over) * pricing_confidence_C`
`multiplier = 1 + (2 * intensity)` (ranges 1x to 3x)
`raw_step = base_step * multiplier`

Caps applied in order: raw_step, early anti-brigade cap, dynamic cap, catch-up cap, final clamp >= base_step.

### Catch-Up Mode

Activates when: `weighted_total >= 15`, `unique_voters >= 12`, `dominant_pct >= 0.60`. Disabled if clustered voting detected (70%+ of last 10 votes within 60 seconds from 2 or fewer IP hashes). Max catch-up step: 20% of anchor price, absolute max $80.

### Momentum Buffer

UP moves increment momentum_score, DOWN moves decrement. Opposite direction consumes momentum first. On cycle reset, momentum decays toward zero by one step.

### Cycles

Cycle resets when: price has moved >= 7% from cycle start AND (weighted_total >= 20 OR unique_voters >= 15). On reset: new cycle_id, all weighted counters reset.

### Vote Credit System

Max 3 lifetime vote credits per user per brick. Each vote consumes 1 credit. Credits regained if live price moves >= 7% from user's last vote price, or brick enters recheck. Votes during freeze still consume credits.

### Freeze Mode

Entry: `p_fair >= 0.55` AND `weighted_total >= 20`.
During freeze: price locked, votes logged, XP earned, but votes do NOT affect pricing and are discarded on exit. UI shows soft stability messaging only ("Line holding steady", "High confidence market"). Never show "Frozen", "No impact", or "Analytics-only".
Exit: recheck trigger or freeze timeout (14 to 30 days). On exit: new cycle begins, counters reset.

### Recheck State

Recheck feels intentionally different from freeze. Required UI elements: "Recheck mission" label, "Help refresh this price", XP bonus indicator (e.g. "2x XP").

### Access Levels

- **Logged out:** Can browse, cannot vote, cannot see sentiment or confidence.
- **Logged in, email NOT verified:** Can access vote UI, but vote weight = 0, no XP, no audits, no signal reveal.
- **Logged in, email verified:** Full weighted votes, XP, audits, signal reveal after voting.

### Key Tables

- `vote_events` — immutable append-only ledger, one record per vote. No UPDATE, no DELETE.
- `xp_events` — immutable XP ledger tied to vote actions.
- `brick_price_state` — authoritative derived state, worker-owned, read-only to clients.

### UI Rules (Locked Law)

- No price percentages ever shown
- No range percentages ever shown
- No caps or thresholds exposed
- Sentiment % allowed after vote only
- Confidence % allowed after vote only

### Daily Snapshots

Daily close at 11:07 PM EST. Repeats last close if no votes. No intraday candles.

---

## Milestone 2 — BearbrickDex

**Status:** Complete and delivered in two phases.

### M2a — Dex Phase 1 (complete)

Built the foundational Dex infrastructure:

- User stage progression system (Stage 0 through Stage 3)
- Context system for deterministic state derivation
- Replay-safe and deterministic architecture
- Full-text search across the brick catalogue
- Admin endpoints for catalogue management
- 5 seeded catalogue entries for testing

### M2b — Dex Phase 2 (complete)

Completed the full Dex system:

- Complete Dex discovery and completion mechanics
- Maintenance loop for catalogue health
- XP infrastructure hooks for Dex interactions
- Completion metrics and progress tracking
- Search and profile APIs
- Fully replay-safe across all operations

### Dex Purpose

The BearbrickDex is a complete encyclopedic catalogue of all BE@RBRICK figures. Users can discover, track, and complete their knowledge of the full catalogue. Completion progress feeds into the XP and gamification systems built in Milestone 3.

### Key Data

The client is migrating a large Google Sheet of BE@RBRICK data into Supabase. The catalogue is expected to contain 5,200+ active eligible brick entries at launch. This migration is still in progress on the client side.

---

## Milestone 3 — XP and Gamification Engine

**Status:** SHIPPED. All four sub-phases delivered.

The full XP spec (64 pages, canonical developer specification) was reviewed and all 14 clarifying questions answered by the client. The contribution, moderation, and bounty subsystem was explicitly out of scope for M3 and is now Milestone 4.

---

### M3a — Core XP Foundation

**Status:** SHIPPED.

**Scope:**

- `xp_events` table — immutable XP ledger. Every XP grant is one append-only event. Workers never recompute from current config during replay; they always use `event.xp_delta_signed`.
- `local_day_key` column on `xp_events` — computed at write time using user timezone and 5AM reset boundary. Workers must always use the stored value, never `now()`. This was added as a spec patch after Q6 clarification.
- `user_progress_state` — derived read model for current XP total, level, and lifetime stats. Worker-owned.
- `level_definitions` table — configurable level thresholds and band labels. Not hardcoded.
- `level_up_events` — immutable record of every level transition.
- `xp_adjustment_events` — explicit events for any intentional XP correction. The only allowed way to change historical XP.
- `xp_idempotency_keys` table — prevents duplicate XP grants across all systems.
- `user_daily_xp_counters` — per user per local_day_key counters for passive, action, vote, and contribution XP buckets. Used for cap enforcement.
- `xp_config_versions` table — versioned config for base XP values, bonus ranges, decay curves, daily caps. All XP values are configurable without code changes.
- **XP Reconciliation Worker** — consumes xp_events in deterministic order (ORDER BY created_at ASC, id ASC), updates user_progress_state, emits level_up_events. Cursor-based, idempotent, advisory locked per user.

**Key Rules:**

- Pending XP is visible but labeled. It does NOT trigger level-ups, streaks, or unlocks.
- Confirmed XP drives all progression.
- Users never lose levels under any circumstances.
- Rejected contribution items silently remove pending XP only. No negative XP event, no penalty language shown.
- XP decay and caps: passive XP has aggressive decay and hard daily cap. Vote XP has light decay if spammed. Contribution, challenge, streak, and milestone XP have no decay.
- Level 0 exists pre-first action. First XP event immediately triggers Level 1.
- Infinite leveling. XP bar always globally visible.

---

### M3b — Sessions and Streaks

**Status:** SHIPPED.

**Scope:**

- `daily_session_sets` — the universal global Morning and Evening brick lists. Morning 7 and Evening 11 draw from one shared global rotation pool. 18 unique bricks consumed per day. A brick must never appear in both Morning and Evening on the same day. Pool is all 5,200+ active eligible bricks. On cycle exhaustion, reshuffle and restart with new `rotation_cycle_id`.
- `daily_session_set_items` — the individual bricks assigned to each session set.
- `user_session_progress` — per user per session tracking of which bricks have been voted, partial counts, and completion state.
- `user_streak_state` — Morning streak and Evening streak tracked completely independently.
- `active_votes` — one record per user per brick, updated on re-vote. Tracks current vote stance.
- **Session Progress Worker** — tracks Morning 7 and Evening 11 completion, awards streak credits, handles window expiry. Triggered when session completes or window expires.
- **Guest Session Conversion Logic:**
  - If session is still active at signup (Morning: before 3PM local, Evening: before 3AM local), carry over partial_count and counted_brick_ids. Guest XP is always discarded with no exceptions.
  - If session has expired at signup, everything resets to zero.
  - Counted brick IDs must be migrated to enforce unique (user_id, session_set_id, brick_id) and prevent double-counting.
  - UX: if carried, show "You're already on Morning X/7". If reset, show "That session ended, start fresh". Never mention XP loss.

**Session Windows:**

- Morning 7: 5AM to 3PM local user time
- Evening 11: 5PM to 3AM local user time
- Dead windows (3PM to 5PM and 3AM to 5AM): neither session active

**Key Rules:**

- Must complete ALL bricks in a session to earn completion bonus and advance streak.
- Partial completion earns base XP only, no streak credit, no bonus.
- Morning and Evening streaks are completely independent.
- Crossing midnight does NOT break the logical day. Evening 11 completing at 1AM still belongs to the same logical day as the Morning session.
- Logical day resets at 5AM local user time.

---

### M3c — Challenge Engine

**Status:** SHIPPED.

**Scope:**

- `challenge_templates` — every challenge definition including family, eligibility rules, target counts, XP rewards, difficulty bands, eligible lifecycle states, and time windows. Adding a new challenge after launch = inserting a new row. No code change needed.
- `challenge_daily_pool` — the 7-challenge global daily pool with fixed family mix: 2 vote, 1 explore, 1 maintain, 1 category mastery, 1 contribute, 1 wildcard.
- `user_challenge_assignments` — 5 daily challenges assigned per user. Assigned on first meaningful action after 5AM local. Fixed for the day. 3 weekly challenges reset Monday 5AM local.
- `challenge_completion_events` — immutable record of every challenge completion. `idempotency_key` UNIQUE.
- `perfect_day_events` — immutable record of every Perfect Day achievement.
- **Challenge Assignment Worker** — assigns 5 dailies per user on first meaningful action. Enforces eligibility filtering: required time window available, eligible targets exist, user can perform the required action, task not already fulfilled, no overlap or duplication. Fallback pool only pulls from challenges that pass the same impossibility validator. A challenge is impossible if the user has no valid path to complete it within the challenge window.
- **Challenge Progress Worker** — updates assignment progress from incoming events, emits completion XP events, evaluates Perfect Day conditions.

**Perfect Day:**

- Requirements within the same `local_day_key`: Morning 7 complete, Evening 11 complete, all 5 daily challenges complete.
- Award is event-driven and immediate once all 3 conditions are met. Do NOT wait for cron.
- Idempotency key: `perfect_day:{user_id}:{local_day_key}` (literal string, asserted by string equality in tests).
- Crossing midnight is fine, it still counts as one logical day.

**Challenge Families:**

- New challenge type with new behavior = config + minor backend update for new progress matching logic.
- New daily or weekly challenge = config only, no code change.

**XP Bonuses (MVP):**

- Flat additions only, no multipliers in MVP.
- +5 streak bonus per valid streak completion.
- Challenge completion bonuses for Morning 7, Evening 11, all 5 dailies, Perfect Day.
- UX language must say "+5 Streak Bonus", never "multiplier".

**Known temporary degradations (handled by graceful pass-through):**

- `user_progress_state.lifecycle_state` column absent. Eligibility filter defaults to "active". Activates automatically when the auth/admin milestone adds the column.
- `bricks.category` column absent. `per_unique_category` strategy degrades to `per_unique_brick`.
- `brick_vote_state.stale_status` not populated. Stale-only templates filtered out at assignment time.

---

### M3d — Leaderboards and Rewards

**Status:** SHIPPED.

**Scope:**

- `leaderboard_definitions` — configurable leaderboard metadata. Adding a new leaderboard = inserting a row, config only.
- `leaderboard_state` — derived rolling state with per-period ranks, eligibility, and tie-break fields. Single table with composite indexes.
- `leaderboard_period_finalizations` — idempotency guard for an entire period's reward issuance. UNIQUE on (leaderboard_key, period_key).
- `leaderboard_visibility_snapshots` — anti-sniping window snapshots, written when nowUtc first enters the window. Separate from finalization so the two lifecycles stay independent.
- `leaderboard_rewards` — pre-seeded reward bundles per board per placement tier.
- `leaderboard_reward_events` — immutable record of every cosmetic issued for placement. UNIQUE on (user_id, leaderboard_key, period_key, placement_tier) and on `idempotency_key`. Mirrors `challenge_completion_events.idempotency_key` precedent.
- `calling_cards`, `badges`, `flourishes`, `titles` — cosmetic catalogue tables. Adding new items = config only.
- `user_rewards` — generic ownership table linking users to earned cosmetics. UNIQUE on (user_id, reward_type, reward_id, tier).
- `inbox_entries` — user-facing event feed for level_up, contribution_approved, contribution_rejected, daily_completed, weekly_completed, perfect_day, streak_broken, leaderboard_reward, system_notice events. M3d writes only leaderboard_reward entries directly.
- **Leaderboard Worker** — 5-second poll, cursor-based on xp_events.id and user_completion_state.updated_at. Per-period advisory locks.
- **Period Finalization Worker** — 60-second poll. Closes due periods, snapshots top-N, issues rewards, writes anti-sniping visibility snapshots.

**Seeded MVP boards:**

- Lifetime: `lifetime_collector_xp`, `lifetime_contribution_weighted` (score function stubbed pending Milestone 4), `lifetime_dex_completion` (reads `user_completion_state.lifetime_pct` from M2 directly).
- Rotating weekly: `weekly_collector_xp`, `weekly_contribution_weighted` (score function stubbed pending Milestone 4).

**Tie-Break Rules:**

- Source of truth: `xp_events.created_at` (canonical event time), never worker update time or batch order.
- Worker tracks cumulative XP in deterministic order (ORDER BY created_at ASC, id ASC) and records the event timestamp when the user first reaches their final score.
- Secondary tie-break: `xp_events.id`. Tertiary: stable `user_id` order.

**Leaderboard Period and Local Time:**

- Weekly leaderboard resets on a single global UTC clock.
- Weekly challenges reset Monday 5AM local user time.
- XP earned before the global UTC reset counts toward the previous leaderboard week even if the challenge belongs to a new local cycle. No correction logic applied.
- UX handles this with "Resets globally every Monday" messaging.

**Idempotency key shapes (literal strings, asserted by string equality):**

- `lb_reward:{leaderboard_key}:{period_key}:{user_id}:{placement_tier}`
- `lb_finalization:{leaderboard_key}:{period_key}`

**Known temporary degradations (handled by graceful pass-through):**

- `users.is_banned` column absent. LeaderboardEligibilityService gracefully passes the ban filter when missing.
- `user_progress_state.lifecycle_state` column absent (same as M3c).
- `approved_contribution_weight` score function returns 0 until Milestone 4 wires it.

---

## Shared Library Helpers (Reuse, Do Not Duplicate)

The following helpers are established and stable across the Milestone 3 series. Any new milestone must reuse them rather than re-implementing the same logic.

- `src/lib/xpEvents.js` — shared `insertXpEvent` helper. Use this for any XP event insert across the codebase.
- `src/lib/weeks.js` — Monday 5 AM local-week boundary helpers, DST and timezone-aware. Used for M3c weekly challenges.
- `src/lib/utcWeeks.js` — UTC ISO-week boundary helpers. Used for M3d leaderboard periods.
- `xp_idempotency_keys` table — cross-domain idempotency for XP-minting operations. For non-XP one-time operations, follow the M3c/M3d precedent of per-table `idempotency_key` UNIQUE columns instead.

**Advisory lock convention:** every worker takes `pg_advisory_xact_lock` inside its transaction with a key derived from the natural scope of the operation (per-user, per-period, per-(user, period, tier), etc.).

---

## Current Test Baseline and Known Pre-Existing Flakes

**Baseline:** 424 of 426 tests passing as of M3d delivery. New milestones must preserve this baseline plus add their own tests.

**Two documented pre-existing flakes** (both diagnosed as local dev-DB-volume accumulation artifacts, not real defects, fixes deferred to a future test hygiene pass):

1. **`tests/api/dex-admin-dashboard.test.js`** — M2-owned test. Its `beforeAll` creates "Feature Toggle Brick" rows without cleanup. Accumulated rows push the test's brick past the `/api/dex/bricks/featured` endpoint's default `limit: 20` page boundary. Documented in `project_m2_flaky_test.md`.
2. **`tests/workers/leaderboard-worker-integration.test.js` "Q9 UTC period boundary"** — M3d-discovered. Dev DB now holds 572+ confirmed `xp_events` accumulated across prior runs. Test inserts W22 events after the existing max date, but the worker polls `xp_events ORDER BY createdAt ASC, id ASC LIMIT 500`, pushing the W22 events past position 500 and missing the single tick the test runs. Documented in `project_m3d_flaky_test.md`.

**Rule for future milestones:** do not touch these tests, do not "fix" them, do not patch around them. They are known, documented, and fail on local dev DBs only. On a clean clone or CI they pass.

---

## Milestone 4 — Bounty System MVP

**Status:** ACTIVE / NOT YET STARTED. Two-phase delivery.

### Purpose

A controlled crowdsourced contribution system where users help fill missing BE@RBRICK fields (packaging images, side view, bottom stamp, release year, release method, notes) in exchange for cash, XEdition Credits, and XP. Admin approves every reward before issuance. The system pays out manually via PayPal or Venmo outside the app and tracks balances and payout requests internally.

Bounty MVP is explicitly NOT a marketplace, credit store, reviewer network, or automated image-verification system.

### Two-Phase Delivery

The milestone is split into two Fiverr milestones with a halfway review checkpoint:

- **Phase A (Milestone 1 of 2):** Foundation and money plumbing. All 13 migrations, core services, atomic approval and approve-and-apply transactions, payout flow, all three background workers, plus unit and integration tests. At the halfway review, bounties auto-generate from missing brick fields, balances update correctly through the approval transaction, payouts flow through the state machine cleanly, and the full test suite is green.
- **Phase B (Milestone 2 of 2):** API surface and live delivery. 7 user endpoints, 9 admin endpoints, API-layer tests, full live end-to-end smoke against the dev environment with real Supabase Storage, final work log.

### Scope

**Database (13 new migrations, all additive):**

Bounty core (8 tables):

- `bounty_definitions` — the 8 seeded bounty types with reward amounts.
- `bounty_instances` — specific bounties per brick. Partial unique index prevents duplicate open bounties.
- `bounty_submissions` — user submissions with 4-state machine (PENDING, APPROVED, REJECTED, APPLIED_TO_BRICK). Reward amounts captured at submission time.
- `user_balances` — cash and credit balances with reserved cash tracking. One row per user created on signup.
- `bounty_reward_events` — immutable reward ledger. UNIQUE on (bounty_submission_id, event_type).
- `payout_requests` — payout state machine (REQUESTED, APPROVED, PAID, REJECTED) with reserved cash accounting.
- `user_bounty_stats` — submission counters and approval rate. Daily limit reset at 5 AM local with UTC fallback.
- `admin_settings` — monthly budget config, cash-rewards-enabled flag, minimum payout.

Auth foundation (forward-compatible with the locked auth/admin spec):

- `users.role` enum column — values: user, trusted_user, moderator, admin, super_admin, developer. Default 'user'.
- `users.permission_overrides` JSONB nullable — future-ready for per-user flag overrides.
- `users.email_verified_at` timestamp nullable — image-based bounty submissions gate on this.
- `users.account_state` enum column — values: active, email_unverified, read_only, suspended_temporary, banned_permanent. Default 'active'.
- `users.paypal_handle` and `users.venmo_handle` — profile-default payout handles, editable per request.

Audit:

- `payout_action_events` — immutable, append-only. One row per payout state transition with actor_user_id, action, timestamp, notes.

Storage:

- Supabase Storage bucket `bounty-submissions` configured with 10 MB size limit, JPG/PNG MIME allowlist, signed URL access.

**Services** (`src/services/bounties/`):

- `BountyDefinitionService` — thin read layer over definitions plus admin_settings.
- `BountyInstanceService` — auto-generation and closure logic. Respects `bounty_definitions.is_active` for global pause-by-type.
- `BountySubmissionService` — validation pipeline. Checks account state, email verification, daily limit, and bounty CLOSED status (auto-reject "Already exists").
- `ImageUploadService` — wraps Supabase Storage upload. Validates JPG/PNG, min 800x800, max 10 MB. Returns signed URL.
- `BountyEligibilityService` — defensive read of account_state and email_verified_at. Graceful pass-through when columns not populated (mirrors M3c/M3d pattern).
- `BountyApprovalService` — atomic approve transaction. Mints reward, updates balances and lifetime totals, increments monthly cash spent, writes xp_event.
- `BountyApprovalAndApplyService` — extends approval with canonical brick field update. Closes bounty if field now filled.
- `PayoutService` — request, reserve, approve, mark paid, reject. Multiple pending payouts allowed. Idempotent on Mark Paid.

**Workers** (`src/scripts/`):

- `auto-bounty-generator-worker` — daily run. Creates instances for missing fields, closes bounties when fields fill.
- `monthly-budget-reset-worker` — first of each month at 00:00 UTC.
- `daily-submission-counter-reset-worker` — 5 AM local user time with UTC fallback.

**Library helpers** (`src/lib/`):

- `permissions.js` — `hasRole(user, 'admin' | 'super_admin')` for this milestone. Extends to `hasPermission(user, flag)` when the full auth milestone ships.
- `imageValidation.js` — JPG/PNG, dimension, size checks.
- `moneyMath.js` — cents-only integer math helpers. No floating-point dollars anywhere in the codebase.

**API endpoints (16):**

User-facing (7):

- `GET /api/bounties` — open bounties with filters. Sorted by priority then created_at.
- `GET /api/bricks/:brickId/bounties` — open bounties for a specific brick.
- `POST /api/uploads/bounty-image` — separate upload step.
- `POST /api/bounties/:bountyInstanceId/submissions` — submission entry point.
- `GET /api/me/bounty-submissions` — user's own history.
- `GET /api/me/balances` — cash, reserved cash, available cash, credit balance, lifetime earnings.
- `POST /api/me/payout-requests` — creates payout request and reserves cash.

Admin-facing (9):

- `GET /api/admin/bounty-submissions` — review queue. Oldest pending first, filter by bounty_type and brick_id, pagination at 50.
- `POST /api/admin/bounty-submissions/:id/approve`
- `POST /api/admin/bounty-submissions/:id/approve-and-apply`
- `POST /api/admin/bounty-submissions/:id/reject`
- `POST /api/admin/bounties` — manual bounty creation.
- `PATCH /api/admin/bounty-definitions/:id` — adjust rewards or pause a bounty type globally.
- `PATCH /api/admin/bounty-instances/:id` — pause, close, or reopen a specific bounty.
- `GET /api/admin/payout-requests`
- `PATCH /api/admin/payout-requests/:id` — approve, mark paid, or reject.

All admin endpoints gated by `hasRole(user, 'admin' | 'super_admin')`. Controllers thin, all business logic in services.

### Bounty Types and Rewards (MVP)

| Type            | Priority | Cash  | Credits |
| --------------- | -------- | ----- | ------- |
| PACKAGING_FRONT | High     | $0.50 | 50      |
| PACKAGING_BACK  | High     | $0.75 | 75      |
| BACK_OF_FIGURE  | High     | $0.40 | 40      |
| SIDE_VIEW       | Medium   | $0.25 | 25      |
| BOTTOM_STAMP    | High     | $0.50 | 50      |
| RELEASE_YEAR    | Medium   | $0.15 | 15      |
| RELEASE_METHOD  | Medium   | $0.25 | 25      |
| NOTES_CONTEXT   | Medium   | $0.25 | 25      |

Credits mirror cash in cents at MVP. Cash mirrors credits even when cash rewards are paused by budget cap.

### Key Rules

- Bounties tie to specific bricks. Users cannot directly edit canonical brick data.
- Admin approval is required before any reward is issued.
- Simple Approve does NOT close the bounty. Approve+Apply does. Once closed, later submissions auto-reject as "Already exists" unless admin reopens.
- Rewards captured at submission time on `bounty_submissions` (immune to mid-flight definition changes).
- Monthly cash budget caps approved cash spending. When the cap hits, cash pauses but credits and XP continue (full credit, $0 cash, full XP).
- BRICK_COMPLETED XP event fires for the user who closes the last bounty on a brick.
- Image-based bounty submissions require `email_verified_at` to be non-null.
- Submissions blocked for users with `account_state` in (read_only, suspended_temporary, banned_permanent).
- Daily submission limit: 10 per user. All submissions count regardless of outcome.
- Minimum payout: $10. Multiple pending payout requests allowed.

### Reused From Prior Milestones

- `src/lib/xpEvents.js` for the BOUNTY_SUBMISSION_APPROVED, FIRST_APPROVED_BOUNTY, TEN_APPROVED_BOUNTIES, BRICK_COMPLETED XP event inserts.
- `xp_idempotency_keys` table for XP-minting idempotency.
- Per-table `idempotency_key` UNIQUE columns for non-XP one-time operations (`bounty_reward_events`, `payout_action_events`).
- `pg_advisory_xact_lock` per-user and per-payout for transaction safety.

### Activates Dormant Hooks From M3c and M3d

When the bounty milestone ships, several previously-stubbed pieces light up:

- M3c's `contribute` challenge family becomes assignable (currently filtered by `featureFlags.contribution_system_enabled`).
- M3d's `lifetime_contribution_weighted` and `weekly_contribution_weighted` leaderboards begin populating (currently score function returns 0).

Flipping the appropriate config flag at the end of the bounty milestone is the activation step.

### Idempotency Key Shapes (Literal Strings)

- `bounty_reward:{bounty_submission_id}:approved`
- `bounty_reward:{bounty_submission_id}:approved_and_applied`
- `payout_paid:{payout_request_id}`
- XP event idempotency keys follow the standard `xp_idempotency_keys` table shape from M3a.

### Out of Scope (Per Locked Spec Section 4)

Explicitly NOT in Milestone 4: artist/brand/category bounties, sale comp bounties, size confirmation bounties, supply amount bounties, automated duplicate detection, automated image matching, automated trust-weighted reviewing, ownership proof, watermark/date-card proof, community flagging, multi-review approval, trusted contributor tiers, credit store, automated payouts, full RBAC enforcement (the 14 permission flags), email verification flow, account state management UI, admin dashboard frontend.

---

## Upcoming Milestones (Not Yet Scoped in Detail)

These are confirmed as future work. None have been formally scoped or priced yet.

- **Auth and Login Milestone** — account creation, email verification, session management, full RBAC permission-flag enforcement layer, account state management (read_only, suspended, banned), Trusted User auto-promotion, brick edit proposal flow (for fields outside the bounty scope), report queue, image approval for non-bounty images, appeals.
- **Moderation Extension** — extends the bounty admin queue into a general moderation queue covering reports, image approval, ban authority, audit log review. Built on top of the bounty milestone's `payout_action_events` audit pattern.
- **Swipe Voting UI** — mobile-first dating-app style price voting interface.
- **User Dashboard and Collections** — profile, XP bar, level display, streak tracking, Dex completion, owned cosmetics, bounty contribution stats.
- **Admin Dashboard UI** — frontend for the bounty admin endpoints plus all auth/moderation endpoints. Backend lands in the auth milestone, frontend lands here.
- **Full Frontend Assembly** — wiring all UI together from Canva wireframes, navigation, responsive layout, polish.
- **BearbrickDex Google Sheet to Supabase Migration** — client is still building the source sheet.
- **AI Image Recognition** — Phase 2 separate project, not yet scoped.

---

## Global Architecture Rules

These rules apply everywhere in the codebase without exception.

1. **Event-sourced only.** All state is derived from append-only event tables. No business logic in API handlers. No client-side state mutation.
2. **Workers own state tables.** State tables (`brick_price_state`, `user_progress_state`, `leaderboard_state`, `user_balances`, etc.) are written only by workers or by services running inside locked transactions. APIs read from them but never write directly outside the service layer.
3. **Determinism is mandatory.** Every outcome must be reproducible by replaying event logs. Workers must use stored values on events (xp_delta_signed, local_day_key, fair_range at vote time, reward amounts captured at submission time, etc.), never recompute from current config.
4. **Idempotency everywhere.** Every worker operation must be safe to run multiple times. Use `xp_idempotency_keys` for XP-minting operations. Use per-table `idempotency_key` UNIQUE columns for non-XP one-time operations (the M3c, M3d, and Milestone 4 precedent).
5. **No hardcoded values.** XP amounts, challenge definitions, leaderboard definitions, reward definitions, level thresholds, bounty rewards, monthly budgets — all live in config tables. Adding new content should rarely require a code change.
6. **Pending XP is not real XP.** Pending XP is visible in UI but cannot trigger level-ups, streaks, unlocks, or leaderboard ranking. Only confirmed XP drives progression.
7. **Users never lose levels.** Removing pending XP on rejection is a silent state correction, not a loss event. No negative XP framing ever shown to users.
8. **local_day_key is always stored at write time.** Computed using user timezone and 5AM local reset boundary. Workers always use the stored value, never derive it from `now()`. Leaderboard periods are the exception: those use UTC week boundaries via `src/lib/utcWeeks.js`.
9. **Advisory locks per natural scope.** Per-user for XP reconciliation, per-(leaderboard_key, period_key) for leaderboard work, per-user-per-payout for payout transactions. Prevents race conditions when multiple events for the same scope are processed concurrently.
10. **Admin actions are always logged.** Every admin action writes an immutable record (`admin_action_logs` for general admin work, `payout_action_events` for payout state transitions, `bounty_reward_events` for bounty approvals, `level_up_events` for XP transitions, etc.). No exceptions.
11. **Cents-only integer math for money.** No floating-point dollars anywhere in the codebase. All money values stored in `*_cents INTEGER` columns. The `src/lib/moneyMath.js` helper is the only sanctioned arithmetic on money values.

---

_This file should be updated at the completion of each milestone._
