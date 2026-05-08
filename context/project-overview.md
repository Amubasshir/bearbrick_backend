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

**Status:** NOT YET STARTED. Broken into 4 phases. .

The full XP spec (64 pages, canonical developer specification) has been reviewed and all 14 clarifying questions have been answered by the client. The system is fully specced and ready to build. The contribution, moderation, and bounty subsystem is explicitly out of scope for this milestone and will be a separate phase later.

---

### M3a — Core XP Foundation

**Status:** Not started.

**Scope:**

- `xp_events` table — immutable XP ledger. Every XP grant is one append-only event. Workers never recompute from current config during replay; they always use `event.xp_delta_signed`.
- `local_day_key` column on `xp_events` — computed at write time using user timezone and 5AM reset boundary. Workers must always use the stored value, never `now()`. This was added as a spec patch after Q6 clarification.
- `user_progress_state` — derived read model for current XP total, level, and lifetime stats. Worker-owned.
- `level_definitions` table — configurable level thresholds and band labels. Not hardcoded.
- `level_up_events` — immutable record of every level transition.
- `xp_adjustment_events` — explicit events for any intentional XP correction. The only allowed way to change historical XP.
- `idempotency_keys` table — prevents duplicate XP grants across all systems.
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

**Status:** Not started.

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

**Status:** Not started.

**Scope:**

- `challenge_templates` — every challenge definition including family, eligibility rules, target counts, XP rewards, difficulty bands, eligible lifecycle states, and time windows. Adding a new challenge after launch = inserting a new row. No code change needed.
- `challenge_daily_pool` — the 7-challenge global daily pool with fixed family mix: 2 vote, 1 explore, 1 maintain, 1 category mastery, 1 contribute, 1 wildcard.
- `user_challenge_assignments` — 5 daily challenges assigned per user. Assigned on first meaningful action after 5AM local. Fixed for the day. 3 weekly challenges reset Monday 5AM global.
- `challenge_completion_events` — immutable record of every challenge completion.
- `perfect_day_events` — immutable record of every Perfect Day achievement.
- **Challenge Assignment Worker** — assigns 5 dailies per user on first meaningful action. Enforces eligibility filtering: required time window available, eligible targets exist, user can perform the required action, task not already fulfilled, no overlap or duplication. Fallback pool only pulls from challenges that pass the same impossibility validator. A challenge is impossible if the user has no valid path to complete it within the challenge window.
- **Challenge Progress Worker** — updates assignment progress from incoming events, emits completion XP events, evaluates Perfect Day conditions.

**Perfect Day:**

- Requirements within the same `local_day_key`: Morning 7 complete, Evening 11 complete, all 5 daily challenges complete.
- Award is event-driven and immediate once all 3 conditions are met. Do NOT wait for cron.
- Idempotency key: `perfect_day:{user_id}:{local_day_key}`
- Crossing midnight is fine — it still counts as one logical day.

**Challenge Families:**

- New challenge type with new behavior = config + minor backend update for new progress matching logic.
- New daily or weekly challenge = config only, no code change.

**XP Bonuses (MVP):**

- Flat additions only, no multipliers in MVP.
- +5 streak bonus per valid streak completion.
- Challenge completion bonuses for Morning 7, Evening 11, all 5 dailies, Perfect Day.
- UX language must say "+5 Streak Bonus", never "multiplier".

---

### M3d — Leaderboards and Rewards

**Status:** Not started.

**Scope:**

- `leaderboard_definitions` — configurable leaderboard metadata. Adding a new leaderboard = inserting a row, config only.
- `leaderboard_state` — near real-time derived rankings. Worker-owned.
- `leaderboard_rewards` and `leaderboard_reward_events` — cosmetic-only rewards for leaderboard placement in MVP. No XP rewards.
- `calling_cards`, `badges`, `flourishes`, `titles` — cosmetic reward tables. Adding new items = config only, no code changes.
- `user_rewards` — generic ownership table linking users to earned cosmetics.
- `inbox_entries` — user notification inbox for level_up, contribution_approved, contribution_rejected, daily_completed, weekly_completed, perfect_day, streak_broken, leaderboard_reward, system_notice events.
- **Leaderboard Worker** — near real-time cadence (1 to 5 second target). Eligibility filtering before ranking. Anti-sniping window near reset. Period finalization and reward issuance on reset.

**Leaderboard Types:**

- Permanent: lifetime XP, lifetime weighted contributions, Dex completion.
- Rotating: weekly XP, weekly contributions.

**Tie-Break Rules:**

- Source of truth: `xp_events.created_at` (canonical event time), never worker update time or batch order.
- Worker tracks cumulative XP in deterministic order (ORDER BY created_at ASC, id ASC) and records the event timestamp when the user first reaches their final score.
- Secondary tie-break: `xp_event.id`. Tertiary: stable `user_id` order.

**Leaderboard Period and Local Time:**

- Weekly leaderboard resets on a single global UTC clock.
- Weekly challenges reset Monday 5AM local user time.
- XP earned before the global reset counts toward the previous leaderboard week even if the challenge belongs to a new local cycle. No correction logic applied.
- UX handles this with "Resets globally every Monday" messaging.

**Reward Configuration:**

- Badges, calling cards, flourishes, titles: config only to add new items.
- Reward unlock rules: mapping layer driven by config.
- Leaderboard rewards: config only to add or modify.

---

## Upcoming Milestones (Not Yet Scoped in Detail)

These are confirmed as future work based on the full client conversation. None have been formally scoped or priced yet.

- **Contribution, Moderation, and Bounty System** — explicitly separated from M3. Includes submission pipeline, reviewer workflow, payout tracking, and moderation event stream.
- **Auth and Login** — account creation, email verification, session management..
- **Swipe Voting UI** — mobile-first dating-app style price voting interface..
- **User Dashboard and Collections** — profile, XP bar, level display, streak tracking, Dex completion, owned cosmetics..
- **Admin Panel and CSV Import** — moderation queue, brick management, data import tooling..
- **Full Frontend Assembly** — wiring all UI together from Canva wireframes, navigation, responsive layout, polish..
- **BearbrickDex Google Sheet to Supabase Migration** — client is still building the source sheet..
- **AI Image Recognition** — Phase 2 separate project, not yet scoped.

---

## Global Architecture Rules

These rules apply everywhere in the codebase without exception.

1. **Event-sourced only.** All state is derived from append-only event tables. No business logic in API handlers. No client-side state mutation.
2. **Workers own state tables.** State tables (brick_price_state, user_progress_state, leaderboard_state, etc.) are written only by workers. APIs read from them but never write directly.
3. **Determinism is mandatory.** Every outcome must be reproducible by replaying event logs. Workers must use stored values on events (xp_delta_signed, local_day_key, fair_range at vote time, etc.), never recompute from current config.
4. **Idempotency everywhere.** Every worker operation must be safe to run multiple times. Use idempotency_keys table for XP and use unique constraints for all derived state writes.
5. **No hardcoded values.** XP amounts, challenge definitions, leaderboard definitions, reward definitions, level thresholds — all live in config tables. Adding new content should rarely require a code change.
6. **Pending XP is not real XP.** Pending XP is visible in UI but cannot trigger level-ups, streaks, unlocks, or leaderboard ranking. Only confirmed XP drives progression.
7. **Users never lose levels.** Removing pending XP on rejection is a silent state correction, not a loss event. No negative XP framing ever shown to users.
8. **local_day_key is always stored at write time.** Computed using user timezone and 5AM local reset boundary. Workers always use the stored value, never derive it from now().
9. **Advisory locks per user for XP reconciliation.** Prevents race conditions when multiple events for the same user are processed concurrently.
10. **Admin actions are always logged.** Every admin action writes an immutable record to admin_action_logs. No exceptions.

---
