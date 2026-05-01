# BE@RBRICK CROWD-SOURCED PRICING ENGINE

# CANONICAL DEVELOPER SPECIFICATION — v1.0 (LOCKED)

- **Owner:** TheFirstEdition
- **Status:** FINAL / LOCKED
- **Architecture:** Event-sourced, deterministic workers
- **Audience:** Backend, infra, data, frontend engineers
- **Design Goal:** Sportsbook-style market correction that is accurate, abuse-resistant, and non-fatiguing

---

## 0. CORE PRINCIPLES (NON-NEGOTIABLE)

1. **Blind Voting** — No sentiment, confidence, percentages, thresholds, caps, or hints are visible before a user votes.
2. **Insight Is Earned** — Sentiment and confidence are revealed only after participation.
3. **Trust Is Behavioral** — Influence is earned through correctness over time, not activity, XP, or tenure.
4. **No Single Actor Can Dominate** — Vote weight is capped, reversible, and risk-aware.
5. **Transparency Without Exploitability** — Users know integrity systems exist; implementation details are never exposed.
6. **Determinism** — All outcomes must be reproducible from event logs alone.

---

## 1. DEFINITIONS

| Term                       | Definition                                     |
| -------------------------- | ---------------------------------------------- |
| **Live Price**             | Current displayed market price                 |
| **Fair Range**             | Displayed ±5% band defining vote meaning       |
| **Cycle**                  | Hypothesis period between qualified moves      |
| **Anchor Price**           | Boundary of fair range used as movement origin |
| **Weighted Vote**          | Vote × user influence weight                   |
| **Pricing Confidence (C)** | Volume-based scalar used in confidence         |
| **Reliability Score (R)**  | Risk signal (non-pricing v1.0)                 |
| **Momentum**               | Correctional inertia preventing oscillation    |
| **Freeze Mode**            | Price locked; participation continues          |

---

## 2. SYSTEM ARCHITECTURE (NON-NEGOTIABLE)

### 2.1 Event-Sourced Design

- Append-only events
- No business logic in API handlers
- No client-side state mutation
- All pricing logic executed by deterministic workers
- State tables are worker-owned and read-only to clients

---

## 3. EVENT TABLES (APPEND-ONLY)

### 3.1 vote_events

Each vote creates exactly one immutable record.

```sql
CREATE TABLE vote_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  brick_id UUID NOT NULL,
  vote_type ENUM('UNDER','FAIR','OVER'),
  live_price_at_vote NUMERIC(12,2),
  fair_range_lower NUMERIC(12,2),
  fair_range_upper NUMERIC(12,2),
  base_step_at_vote INTEGER,
  user_weight_at_vote FLOAT,
  cycle_id UUID,
  created_at TIMESTAMP DEFAULT now(),
  ip_hash TEXT,
  user_agent TEXT,
  session_id TEXT NULL
);
```

**Rules:**

- No UPDATE, No DELETE, No deduplication
- Rate-limited before insert
- Sentiment hidden until insert completes

**Determinism Rule:** `fair_range_lower`, `fair_range_upper`, and `base_step_at_vote` MUST be computed in the worker and logged here so historical replay remains valid even if configs change later.

### 3.2 xp_events

```sql
CREATE TABLE xp_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  vote_event_id BIGINT,
  brick_id UUID,
  xp_amount INTEGER,
  reason ENUM('VOTE','STREAK','RECHECK','ACCURACY'),
  created_at TIMESTAMP
);
```

---

## 4. AUTHORITATIVE STATE (WORKER-OWNED)

### 4.1 brick_price_state

```sql
CREATE TABLE brick_price_state (
  brick_id UUID PRIMARY KEY,
  baseline_price NUMERIC(12,2),
  live_price NUMERIC(12,2),
  current_cycle_id UUID,
  weighted_under FLOAT DEFAULT 0,
  weighted_fair FLOAT DEFAULT 0,
  weighted_over FLOAT DEFAULT 0,
  weighted_total FLOAT DEFAULT 0,
  weighted_since_last_move FLOAT DEFAULT 0,
  p_under FLOAT,
  p_fair FLOAT,
  p_over FLOAT,
  pricing_confidence_C FLOAT,
  reliability_score_R FLOAT NULL,
  momentum_score INTEGER DEFAULT 0,
  last_price_update TIMESTAMP,
  last_high_confidence_price NUMERIC(12,2),
  last_high_confidence_votes FLOAT,
  last_confidence_timestamp TIMESTAMP,
  needs_recheck BOOLEAN DEFAULT FALSE,
  freeze_mode BOOLEAN DEFAULT FALSE,
  freeze_until TIMESTAMP NULL
);
```

**Lock:** All `weighted_*` counters are scoped to `current_cycle_id` only. There is no lifetime `weighted_total` anywhere in the system.

---

## 5. ACCESS LEVELS

| Level                              | Browse              | Vote          | See sentiment/confidence                     |
| ---------------------------------- | ------------------- | ------------- | -------------------------------------------- |
| **Logged Out**                     | ✅                  | ❌            | ❌                                           |
| **Logged In — Email NOT Verified** | ✅ (Vote UI access) | ✅ (weight=0) | ❌ (no XP, audits, signal reveal)            |
| **Logged In — Email Verified**     | ✅                  | ✅ (weighted) | ✅ (after voting; XP, audits, signal reveal) |

---

## 6. VOTING MODEL (LOCKED)

- **UNDER** — Price should be below the lower fair range
- **FAIR** — Price is fair within the range
- **OVER** — Price should be above the upper fair range

Users judge the range, not the center price.

**Internal mapping (math only):** UNDER = −1, FAIR = 0, OVER = +1

**Clarification:** FAIR votes dampen movement by reducing dominant direction share but never create movement.

---

## 7. FAIR RANGE (UI + MECHANICS)

**Calculation (LOCKED):**

- `FAIR_RANGE_PCT = 0.05`
- `lower_range = live_price * (1 - FAIR_RANGE_PCT)`
- `upper_range = live_price * (1 + FAIR_RANGE_PCT)`

**Rules:**

- Fair range does not affect step sizing, caps, or confidence
- Fair range defines vote meaning and anchor boundaries
- Fair range MUST be computed in worker and logged in vote_events

---

## 8. PRICE TIERS & BASE STEP (LOCKED)

```
PRICE_TIERS = [
  { min: 0,    max: 49.99,   base_step: 3 },
  { min: 50,   max: 99.99,   base_step: 5 },
  { min: 100,  max: 149.99,  base_step: 7 },
  { min: 150,  max: 299.99,  base_step: 10 },
  { min: 300,  max: 499.99,  base_step: 15 },
  { min: 500,  max: 999.99,  base_step: 25 },
  { min: 1000, max: 1999.99, base_step: 40 },
  { min: 2000, max: Infinity, base_step: 75 }
];
base_step = tier_for(live_price).base_step;
```

Boundary example: `live_price = 49.99` → Tier 1.

---

## 9. VOTE WEIGHT SYSTEM

```
final_weight = base_account_age_weight * trust_tier_multiplier * behavior_multiplier;
final_weight = clamp(final_weight, 0.0, 1.25);
```

---

## 10. SENTIMENT CALCULATION

```
weighted_total = weighted_under + weighted_fair + weighted_over;
if (weighted_total == 0) { p_under = p_fair = p_over = 0; }
else {
  p_under = weighted_under / weighted_total;
  p_fair  = weighted_fair  / weighted_total;
  p_over  = weighted_over  / weighted_total;
}
```

**Direction:**

- p_over > p_under → UP
- p_under > p_over → DOWN
- Tie → no movement  
  No hard threshold.

---

## 11. PRICING CONFIDENCE (C) — PRICING ONLY

```
pricing_confidence_C = min(1.0, weighted_total / 50);
```

Used for: intensity, multipliers, caps, catch-up eligibility.

---

## 12. RELIABILITY SCORE (R) — NON-PRICING v1.0

Optional in v1.0:

- `volume_score = min(1.0, weighted_total / 50);`
- `reliability_score_R = volume_score;`  
  All other components stubbed. R never affects pricing in v1.0.

---

## 13. WORKER EXECUTION MODEL

- One Price Aggregator Worker per brick (conceptually; implementation may process all bricks sequentially).
- Processes vote_events sequentially.
- On every vote:
    1. Update weighted counters
    2. Increment weighted_since_last_move by user_weight_at_vote only if freeze_mode = false
    3. Recompute sentiment
    4. Recompute pricing_confidence_C
    5. Recompute reliability_score_R
    6. Evaluate movement eligibility

---

## 14. MOVEMENT ELIGIBILITY (LOCKED)

Price may move only if **ALL** are true:

- `weighted_total >= 5`
- `weighted_since_last_move >= 5`
- `freeze_mode == false`

Otherwise: update signal only; do not move price.

---

## 15. ANCHOR-BASED MOVEMENT (CRITICAL)

```
if (dominant === OVER)  { anchor_price = upper_range; new_price = anchor_price + step; }
if (dominant === UNDER) { anchor_price = lower_range; new_price = anchor_price - step; }
```

**Clarifying Rule:** OVER = upward movement (price too low). UNDER = downward movement (price too high). Never move from center price.

---

## 16. INTENSITY & RAW STEP

```
intensity = max(p_under, p_over) * pricing_confidence_C;
multiplier = 1 + (2 * intensity);  // 1x → 3x
raw_step = base_step * multiplier;
```

---

## 17. EARLY ANTI-BRIGADE CAP (SMOOTH RAMP)

Applies while `weighted_total < 20`:

```
early_cap_multiplier = clamp(1.0 + 0.5 * (weighted_total / 20), 1.0, 1.5);
early_max_step = base_step * early_cap_multiplier;
```

---

## 18. DYNAMIC CAPS & CATCH-UP

### 18.1 Normal Cap

```
cap_pct = cap_min + (cap_max - cap_min) * pricing_confidence_C;
max_step = min(cap_pct * anchor_price, ABSOLUTE_CAP);
```

### 18.2 Catch-Up Mode (Order-Aware)

Requires ALL:

- weighted_total >= 15
- unique_voters >= 12
- dominant_pct >= 0.60

**Definitions:** unique_voters = COUNT(DISTINCT user_id), email-verified only, scoped to current_cycle_id.

**Rolling Windows:** W10 = last 10 vote_events in cycle, W20 = last 20.

**Clustered if:** ≥70% of W10 within 60 seconds AND from ≤2 IP hashes → catch-up disabled.

**Catch-Up Cap:** Max 20% of anchor_price; absolute max $80.

**Order of caps (LOCKED):**

1. raw_step
2. early anti-brigade cap
3. dynamic cap
4. catch-up cap
5. final clamp ≥ base_step

---

## 19. MOMENTUM BUFFER

- UP → momentum_score += 1
- DOWN → momentum_score -= 1
- Opposite direction consumes momentum first

On cycle reset:  
`momentum_score = clamp(momentum_score - sign(momentum_score), -2, 2);`

---

## 20. APPLY PRICE MOVEMENT

```
final_step = round(clamp(raw_step, base_step, min(max_step, early_max_step)));
new_price = anchor_price ± final_step;
new_price = max(new_price, 0);
weighted_since_last_move = 0;
```

---

## 21. CYCLES (LOCKED)

Cycle reset only if:

- ≥7% move from cycle start price
- AND (weighted_total >= 20 OR unique_voters >= 15)

On reset: new current*cycle_id; reset all weighted*\*; reset weighted_since_last_move; reset pricing_confidence_C; decay momentum (§19).

---

## 22. VOTE CREDIT SYSTEM (LOCKED)

- Max 3 lifetime vote credits per user × brick
- Each vote consumes 1 credit
- Credits regained if: live price moves ≥7% away from user’s last vote price OR brick enters recheck
- Votes during freeze still consume credits (intentional).

---

## 23. FREEZE MODE (LOCKED)

### 23.1 Entry

- `p_fair >= 0.55` AND `weighted_total >= 20`

### 23.2 Behavior (OPTION A — LOCKED)

During freeze:

- ❌ Price movement
- ✅ Votes logged
- ✅ XP earned
- ❌ Votes do NOT accumulate into pricing counters
- ❌ weighted_since_last_move does NOT increment

Frozen votes are analytics-only and discarded on unfreeze.

### 23.3 Exit

- Recheck trigger OR freeze timeout (14–30 days)
- New cycle begins; counters reset

---

## 24. UI RULES (LOCKED LAW)

- ❌ No price percentages ever shown
- ❌ No range percentages ever shown
- ❌ No caps or thresholds exposed
- ✅ Sentiment % allowed after vote only
- ✅ Confidence % allowed after vote only

---

## 25. SNAPSHOTS & CHARTS

- Daily close at 11:07 PM EST
- Repeat last close if no votes
- No intraday candles

---

## 26. WHAT THIS SYSTEM PREVENTS

Brigading, early anchoring, infinite revoting, XP farming, expert domination, dead bricks, new-user lockout.

---

## FINAL NOTE TO DEVELOPER

This system behaves like a sports betting line, not an auction. The crowd expresses conviction. The engine moves decisively but cautiously. Trust is earned slowly. All behavior is deterministic and auditable. **Implement exactly as written.**

---

## APPENDIX A: GLOBAL CONSTANTS (v1.0 LOCKED)

| Constant                    | Value |
| --------------------------- | ----- |
| FAIR_RANGE_PCT              | 0.05  |
| MIN_WEIGHTED_TOTAL_FOR_MOVE | 5.0   |
| MOVE_BATCH_SIZE_WEIGHTED    | 5.0   |
| N_FULL_CONFIDENCE           | 50.0  |
| ABSOLUTE_CAP_DOLLARS        | 80.0  |
| CATCHUP_MAX_PCT             | 0.20  |
| CATCHUP_MIN_WEIGHTED_TOTAL  | 15.0  |
| CATCHUP_MIN_UNIQUE_VOTERS   | 12    |
| CATCHUP_MIN_DOMINANT_PCT    | 0.60  |
| EARLY_RAMP_MAX_MULT         | 1.5   |
| EARLY_RAMP_WEIGHTED_LIMIT   | 20.0  |
| FREEZE_FAIR_PCT             | 0.55  |
| FREEZE_MIN_WEIGHTED_TOTAL   | 20.0  |
| CYCLE_RESET_MOVE_PCT        | 0.07  |
| CYCLE_RESET_MIN_WEIGHTED    | 20.0  |
| CYCLE_RESET_MIN_UNIQUE      | 15    |
| VOTE_CREDITS_MAX            | 3     |
| CREDIT_REGAIN_MOVE_PCT      | 0.07  |
| MOMENTUM_CLAMP_MIN          | -2    |
| MOMENTUM_CLAMP_MAX          | 2     |

---

## APPENDIX B: WORKERS — EXACT ORDER

### 1) Vote Enricher Worker (vote_intents → vote_events)

**Purpose:** Keep API dumb; compute deterministic fields; consume/regain credits; write vote_events; emit websocket hint.

**Exact order:** cursor → intents (PENDING, id > cursor, LIMIT 500) → for each: (1) user identity FOR UPDATE, (2) brick state FOR UPDATE / bootstrap, (3) fair_lower/upper, (4) base_step, (5) user_weight, (6) credit regain check, (7) enforce credits / reject if none, (8) consume 1 credit, (9) INSERT vote_event, (10) XP event if verified, (11) mark intent PROCESSED, (12) advance cursor, (13) publish brick_vote_event_created.

### 2) Price Aggregator Worker (vote_events → brick_price_state)

**Exact order:** cursor → events (id > cursor, LIMIT 500) → for each: (1) lock brick state, (2) skip if ev.cycle_id != current_cycle_id, (3) skip if freeze_mode (Option A), (4) apply vote to weighted counters + weighted_since_last_move, (5) sentiment, (6) pricing_confidence_C, (7) reliability_score_R, (8) movement eligibility, (9) dominant direction, (10) if not eligible/tie → persist counters only and continue, (11) anchor from ev.fair_range\*\*, (12) base_step from ev, (13) intensity & raw_step, (14) early cap, (15) dynamic cap, (16) catch-up cap, (17) final_step clamp ≥ base_step, (18) momentum buffer (consume first if opposite), (19) apply move if allowed, (20) freeze entry check, (21) cycle reset check, (22) persist state, (23) advance cursor, (24) publish brick_state_updated.

### 3) Daily Snapshot Job (11:07 PM EST)

For each brick: state.live_price, votes_today; close_price = state.live_price or last_close; UPSERT brick_price_history.

---

## APPENDIX C: API CONTRACTS

- **POST /api/vote_intents** — Writes vote_intents only; returns `{ "status": "ACCEPTED", "intent_id": 12345 }`.
- **Websocket:** `brick_state_updated:{brick_id}` or payload with brick_id.
- **GET /api/bricks/{brick_id}/state** — Current state; sentiment/confidence only if user has voted; include last_vote_event_id_processed.

---

## APPENDIX D: POSTGRES MIGRATION (SUMMARY)

Enums: vote_type, xp_reason, intent_status, movement_dir (optional).  
Tables: vote_intents, vote_events, xp_events, brick_price_state, brick_price_history, user_brick_vote_credits, user_identity_state, worker_cursors.  
Indexes as per spec (vote_events brick/time, brick/cycle, user/brick; vote_intents status/created_at; etc.).

---

## APPENDIX E: WORKER MANAGEMENT (OPERATIONAL)

Spec-এ শুধু worker-এর **logic ও exact order** দেওয়া আছে (Appendix B)। **কিভাবে workers চালু/বন্ধ/ম্যানেজ করতে হবে** সেটা operational detail; এই প্রজেক্টে নিচের নীতি follow করা হয়।

### কীভাবে workers চালু রাখতে হয়

- Workers হলো **Artisan commands** (Laravel Queue নয়):  
  `pricing:enrich-votes`, `pricing:aggregate-prices`, `pricing:snapshot`
- প্রতিবার run-এ একটা batch (e.g. 500) process করে command শেষ হয়; নতুন data আসলে আবার same command run করতে হয়।
- তাই **continuously manage** করার দুটো উপায়:
    1. **Production:** Process manager (e.g. **Supervisor**) দিয়ে command গুলো চালু রাখা; command exit করলে Supervisor আবার চালাবে (autorestart)। এভাবে সবসময় নতুন intents/events process হয়।
    2. **Local / Test:** প্রয়োজন হলে হাতে একবার একবার run:  
       `php artisan pricing:enrich-votes` তারপর `php artisan pricing:aggregate-prices`

### ক্রম (order)

1. আগে **Vote Enricher** (`pricing:enrich-votes`) — vote_intents → vote_events
2. তারপর **Price Aggregator** (`pricing:aggregate-prices`) — vote_events → brick_price_state
3. **Daily Snapshot** (`pricing:snapshot`) — scheduled (e.g. 11:07 PM EST); cron/scheduler দিয়ে run।

### Cursor ও state

- প্রতিটি worker **worker_cursors** টেবিল দিয়ে last processed id ট্র্যাক করে (at-least-once)।
- Management-এর সময় cursor reset, log check, restart — সব **operational**; বিস্তারিত প্রজেক্টের deployment/local docs-এ।

### কোথায় বিস্তারিত আছে

- **Production (চালু রাখা, restart, monitor):** [DEPLOYMENT.md](./DEPLOYMENT.md) — Supervisor config, cron, logs, troubleshooting
- **Local run ও test:** [RUN_LOCALLY.md](./RUN_LOCALLY.md), [MANUAL_TEST_STEPS.md](./MANUAL_TEST_STEPS.md), [LOCAL_TESTING.md](./LOCAL_TESTING.md)
- **Laravel Queue:** এই pricing workers Laravel queue দিয়ে চালানোর দরকার নেই; `queue:work` আলাদা।

---

_Document version: v1.0 (LOCKED). Last saved from canonical spec._
