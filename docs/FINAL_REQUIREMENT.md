# BE@RBRICK CROWD-SOURCED PRICING ENGINE

## CANONICAL DEVELOPER SPECIFICATION — v1.0 (LOCKED)

**Owner:** TheFirstEdition  
**Status:** FINAL / LOCKED  
**Architecture:** Event-sourced, deterministic workers  
**Audience:** Backend, infra, data, frontend engineers  
**Design Goal:** Sportsbook-style market correction that is accurate, abuse-resistant, and non-fatiguing

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

| Term                       | Definition                                            |
| -------------------------- | ----------------------------------------------------- |
| **Live Price**             | Current displayed market price                        |
| **Fair Range**             | UI-displayed ±5% band defining vote meaning           |
| **Cycle**                  | Pricing hypothesis period between ≥7% qualified moves |
| **Anchor Price**           | Boundary of fair range used as movement origin        |
| **Weighted Vote**          | Vote × user influence weight                          |
| **Pricing Confidence (C)** | Volume-based scalar used only in pricing math         |
| **Reliability Score (R)**  | UI / risk signal (non-pricing v1.0)                   |
| **Momentum Score**         | Directional inertia preventing oscillation            |
| **Freeze Mode**            | Price locked; participation continues                 |

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

- ❌ No UPDATE
- ❌ No DELETE
- ❌ No deduplication
- ✅ Rate-limited before insert
- ✅ Sentiment hidden until insert completes

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

**Lock:** All weighted\_\* counters are scoped to the current_cycle_id only. There is no lifetime weighted_total anywhere in the system.

---

## 5. ACCESS LEVELS

### 5.1 Logged Out

- ✅ Browse
- ❌ Vote
- ❌ See sentiment / confidence

### 5.2 Logged In — Email NOT Verified

- ✅ Vote UI access
- ❌ Vote weight = 0
- ❌ XP
- ❌ Audits
- ❌ Signal reveal

### 5.3 Logged In — Email Verified

- ✅ Weighted votes
- ✅ XP
- ✅ Audits
- ✅ Signal reveal after voting

---

## 6. VOTING MODEL (LOCKED)

### 6.1 Vote Options

Users must choose exactly one:

| Vote  | Meaning                                    |
| ----- | ------------------------------------------ |
| UNDER | Price should be below the lower fair range |
| FAIR  | Price is fair within the range             |
| OVER  | Price should be above the upper fair range |

Users judge the range, not the center price.

**Internal mapping (for math only):**

- UNDER = −1
- FAIR = 0
- OVER = +1

**Clarification:** FAIR votes dampen movement by reducing dominant direction share but never create movement.

---

## 7. FAIR RANGE (UI + MECHANICS)

### 7.1 Calculation (LOCKED)

```
FAIR_RANGE_PCT = 0.05;
lower_range = live_price * (1 - FAIR_RANGE_PCT);
upper_range = live_price * (1 + FAIR_RANGE_PCT);
```

**Rules:**

- Fair range does not affect step sizing, caps, or confidence
- Fair range defines vote meaning and anchor boundaries
- Fair range MUST be computed in worker and logged in vote_events

---

## 8. PRICE TIERS & BASE STEP (LOCKED)

```
PRICE_TIERS = [
  { min: 0, max: 49.99, base_step: 3 },
  { min: 50, max: 99.99, base_step: 5 },
  { min: 100, max: 149.99, base_step: 7 },
  { min: 150, max: 299.99, base_step: 10 },
  { min: 300, max: 499.99, base_step: 15 },
  { min: 500, max: 999.99, base_step: 25 },
  { min: 1000, max: 1999.99, base_step: 40 },
  { min: 2000, max: Infinity, base_step: 75 }
];

function tier_for(live_price) {
  return first tier where live_price >= min && live_price <= max;
}

base_step = tier_for(live_price).base_step;
```

Boundary example: `live_price = 49.99` → Tier 1

---

## 9. VOTE WEIGHT SYSTEM

```
final_weight = base_account_age_weight * trust_tier_multiplier * behavior_multiplier;
final_weight = clamp(final_weight, 0.0, 1.25);
```

(Weight sources unchanged from prior spec.)

---

## 10. SENTIMENT CALCULATION

```
weighted_total = weighted_under + weighted_fair + weighted_over;

if (weighted_total == 0) {
  p_under = p_fair = p_over = 0;
} else {
  p_under = weighted_under / weighted_total;
  p_fair = weighted_fair / weighted_total;
  p_over = weighted_over / weighted_total;
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

Optional in v1.0.

```
volume_score = min(1.0, weighted_total / 50);
reliability_score_R = volume_score;
```

All other components stubbed. R never affects pricing in v1.0.

---

## 13. WORKER EXECUTION MODEL

One Price Aggregator Worker per brick. Processes vote_events sequentially.

On every vote:

1. Update weighted counters
2. Increment weighted_since_last_move by user_weight_at_vote only if freeze_mode = false
3. Recompute sentiment
4. Recompute pricing_confidence_C
5. Recompute reliability_score_R
6. Evaluate movement eligibility

---

## 14. MOVEMENT ELIGIBILITY (LOCKED)

Price may move only if ALL are true:

- weighted_total >= 5
- weighted_since_last_move >= 5
- freeze_mode == false

Otherwise:

- Update signal only
- Do not move price

---

## 15. ANCHOR-BASED MOVEMENT (CRITICAL)

```
if (dominant === OVER) {
  anchor_price = upper_range;
  new_price = anchor_price + step;
}

if (dominant === UNDER) {
  anchor_price = lower_range;
  new_price = anchor_price - step;
}
```

**Clarifying Rule:** OVER corresponds to upward movement (price too low). UNDER corresponds to downward movement (price too high). Naming reflects user belief, not movement direction.

Never move from center price.

---

## 16. INTENSITY & RAW STEP

```
intensity = max(p_under, p_over) * pricing_confidence_C;
multiplier = 1 + (2 * intensity); // 1x → 3x
raw_step = base_step * multiplier;
```

---

## 17. EARLY ANTI-BRIGADE CAP (SMOOTH RAMP)

Applies while: weighted_total < 20

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

**Definitions:**

- unique_voters = COUNT(DISTINCT user_id)
- Logged-in, email-verified users only
- Scoped to current_cycle_id

**Rolling Windows:**

- W10 = last 10 vote_events in cycle
- W20 = last 20 vote_events in cycle

**Clustered if:**

- ≥70% of W10 within 60 seconds
- AND from ≤2 IP hashes

If clustered → catch-up disabled.

**Catch-Up Cap:**

- Max 20% of anchor_price
- Absolute max $80

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

```
momentum_score = clamp(momentum_score - sign(momentum_score), -2, 2);
```

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

Cycle reset occurs only if:

- ≥7% move from cycle start price
- AND (weighted_total >= 20 OR unique_voters >= 15)

On reset:

- Generate new current_cycle_id
- Reset all weighted\_\* counters
- Reset weighted_since_last_move
- Reset pricing_confidence_C
- Decay momentum (§19)

---

## 22. VOTE CREDIT SYSTEM (LOCKED)

- Max 3 lifetime vote credits per user × brick
- Each vote consumes 1 credit

Credits regained if:

- Live price moves ≥7% away from user's last vote price
- OR brick enters recheck

Votes during freeze still consume credits. This is intentional to prevent farming during stable periods.

---

## 23. FREEZE MODE (LOCKED)

### 23.1 Entry

```
p_fair >= 0.55
AND
weighted_total >= 20
```

### 23.2 Behavior (OPTION A — LOCKED)

During freeze:

- ❌ Price movement
- ✅ Votes logged
- ✅ XP earned
- ❌ Votes do NOT accumulate into pricing counters
- ❌ weighted_since_last_move does NOT increment

Frozen votes are analytics-only and discarded on unfreeze.

### 23.3 Exit

- Recheck trigger
- OR freeze timeout (14–30 days)

On exit:

- New cycle begins
- Counters reset

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

- Brigading
- Early anchoring
- Infinite revoting
- XP farming
- Expert domination
- Dead bricks
- New-user lockout

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

## APPENDIX B: WORKERS — PSEUDOCODE (Exact Order)

### 1) Vote Enricher Worker (vote_intents → vote_events)

**Purpose:** Keep API dumb; compute deterministic fields; consume/regain credits; write vote_events; emit websocket hint.

**Exact Order:**

1. Load user identity / eligibility
2. Load current brick state (authoritative)
3. Compute fair range from live_price_at_vote (±5%)
4. Compute base_step_at_vote (tier_for boundary-precise)
5. Compute user_weight_at_vote
6. Vote credit regain check (only for verified users)
7. Enforce credits (IMPORTANT: freeze votes still consume credits)
8. Consume 1 credit (always if we accept intent)
9. Insert canonical vote_event (append-only)
10. XP event (only if verified; and even during freeze you said XP is allowed)
11. Mark intent processed + attach vote_event_id
12. Advance cursor
13. Notify pricing pipeline / websocket hint

### 2) Price Aggregator Worker (vote_events → brick_price_state)

**Important Locked Behaviors:**

- Aggregates only verified-weighted votes (unverified weight=0)
- All weighted counters are current_cycle_id only
- Freeze mode option A: votes during freeze do not affect pricing counters/state totals
- Movement happens only when: weighted_total >= 5, weighted_since_last_move >= 5, not frozen
- Direction naming clarity: OVER votes imply upward movement (price too low)
- Anchor rule fixed: dominant OVER → anchor = upper_range → price = anchor + step
- Caps order locked: raw_step → early anti-brigade cap → dynamic cap → catch-up cap → final clamp ≥ base_step

**Exact Order:**

1. Lock brick state row
2. Ignore votes from stale cycle ids
3. If freeze_mode = true: Option A locked behavior (skip accumulation)
4. Apply vote to weighted counters
5. Handle weighted_total==0 guard
6. Pricing confidence C (pricing only)
7. Reliability score R (optional v1: volume_score only)
8. Evaluate movement eligibility gates
9. Determine dominant direction from sentiment
10. Movement only if eligible AND not tie
11. Compute fair range + anchor for movement using THIS EVENT'S stored range
12. base_step: use tier_for(live_price_at_vote)
13. Intensity & raw_step
14. Early anti-brigade smooth ramp cap
15. Dynamic cap (confidence-scaled)
16. Catch-up cap (order-aware, anti-cluster)
17. Final clamp ≥ base_step and round
18. Momentum buffer (anti-yo-yo)
19. Apply move if allowed by momentum
20. Freeze entry check (evaluated AFTER counters updated, movement applied)
21. Cycle reset check (>=7% move from cycle start AND volume criteria)
22. Persist state
23. Advance cursor
24. Broadcast update

---

## APPENDIX C: POLLING + WEBSOCKET CONTRACTS (dev-ready)

**POST /api/vote_intents**

- writes vote_intents only
- returns immediately

```json
{ "status": "ACCEPTED", "intent_id": 12345 }
```

**Websocket topic**

- brick_state_updated:{brick_id} or brick_state_updated with payload including brick_id
- emitted by aggregator after commit

**GET /api/bricks/{brick_id}/state**
Returns current state; sentiment/confidence only if user has voted (your UI rule), but backend can still return and frontend decides visibility.

```json
{
  "brick_id": "...",
  "live_price": 156.0,
  "fair_lower": 148.2,
  "fair_upper": 163.8,
  "p_under": 0.12,
  "p_fair": 0.55,
  "p_over": 0.33,
  "pricing_confidence_c": 0.48,
  "freeze_mode": false,
  "current_cycle_id": "...",
  "last_price_update": "...",
  "last_vote_event_id_processed": 991122
}
```

---

## APPENDIX D: DB MIGRATIONS (single consolidated .sql)

See specification document for complete SQL migration script including:

- vote_intents
- vote_events
- xp_events
- brick_price_state
- brick_price_history
- user_brick_vote_credits
- user_identity_state
- worker_cursors

---

## APPENDIX E: RECHECK SYSTEM — CANONICAL SPECS (v1.0)

### 0) Purpose (What "Recheck" is)

Recheck exists to prevent "stale lines" and dead participation without forcing endless revoting. Recheck should:

- surface a small, curated set of bricks per user (missions)
- unlock limited additional vote credits only when truly needed
- unfreeze bricks safely
- preserve sportsbook feel: stable most of the time, responsive when necessary

Recheck is not a global spam reset.

### 1) New/Updated Fields (State)

**Add to brick_price_state:**

- recheck_state TEXT NOT NULL DEFAULT 'NONE' (NONE | WATCH | ACTIVE)
- recheck_reason TEXT NULL (STALE | LOW_SAMPLE | OPPOSING_SIGNAL | POST_FREEZE | ADMIN | PHASE2_DIVERGENCE)
- recheck_started_at TIMESTAMP NULL
- recheck_expires_at TIMESTAMP NULL (TTL window)
- recheck_target_users INT NULL (optional)
- recheck_min_unique INT NULL (optional)

### 2) Recheck Triggers (When a brick gets flagged)

**Trigger A — Stale High-Confidence (time decay)**

- last_confidence_timestamp is NULL OR older than STALE_DAYS (default: 21)
- AND brick is not currently in recheck_state='ACTIVE'

**Trigger B — Low sample / weak cycle**

- cycle age > LOW_SAMPLE_DAYS (default: 7) AND weighted_total_in_cycle < MIN_HEALTHY_WEIGHTED (default: 10)
- not freeze_mode

**Trigger C — Opposing signal (trend check)**

- dominant_pct >= 0.65
- AND pricing_confidence_C < 0.40
- AND dominant direction is opposite the sign of momentum_score

**Trigger D — Post-freeze refresh**

- freeze_mode transitions true → false (timeout or unlock)
- Action: needs_recheck = true, recheck_state = ACTIVE, reason = POST_FREEZE

**Trigger E — Manual / Admin**

- Admin can set ACTIVE for special bricks

### 3) Recheck States (Finite State Machine)

**States:**

- NONE: normal operation
- WATCH: eligible to appear in recheck feeds (light)
- ACTIVE: time-boxed mission mode; used to unfreeze/refresh quickly

**Transitions:**

- NONE → WATCH: triggers A/B/C
- WATCH → ACTIVE: if repeatedly flagged OR freeze ended OR admin
- ACTIVE → NONE: when resolved OR expires

### 4) Recheck Feed / Missions (User-facing)

**Endpoint:** GET /api/recheck/feed?limit=5

Returns a personalized list (3–7/day).

**Eligibility rules:**

- brick_price_state.needs_recheck = true
- AND user is email-verified
- AND user has previously voted on that brick (recommended)
- Not shown if user already voted on it in last X days (cooldown: 7 days)
- Not shown if user has no credits and credit regain isn't allowed

### 5) Recheck Vote Credits

**Canonical Credit System (already locked):**

- Max 3 lifetime credits per user×brick
- Each vote consumes 1 (even in freeze)

**Credits can be regained only if:**

1. live_price moved ≥7% away from user's last_vote_price, OR
2. brick enters recheck (needs_recheck true)

**Add explicit recheck-grant rule:**
When a user requests to vote (VoteEnricherWorker step), if:

- credits_remaining == 0
- AND (brick.needs_recheck == true OR recheck_state == 'ACTIVE')

Then grant exactly +1 credit once per cycle or once per recheck window.

### 6) Recheck XP Bonus (behavioral incentive)

**Rule:**
If user votes on a brick that is needs_recheck=true (WATCH or ACTIVE):

- XP reason = RECHECK
- XP amount = BASE_VOTE_XP \* RECHECK_MULT (default: 2.0)

### 7) How Recheck interacts with Freeze

**Freeze entry is unchanged:**

- p_fair >= 0.55 AND weighted_total >= 20

**During freeze (Option A locked):**

- Votes log + XP
- Votes do not accumulate into pricing counters
- No movement

**Exit from freeze:**

- timeout (14–30 days) OR
- recheck ACTIVE resolution

On exit:

- start a new cycle (new UUID)
- reset weighted counters
- decay/clamp momentum
- set recheck_state = ACTIVE for 7 days (post-freeze refresh)

**Active recheck resolution (unfreeze proof):**
If recheck_state=ACTIVE, the brick exits ACTIVE → NONE when:

- unique_voters_in_cycle >= 12
- AND weighted_total >= 15
- AND either: confidence_C >= 0.50, OR weighted_total >= 25

---

## APPENDIX F: TRUST & WEIGHT GOVERNANCE SYSTEM

### 0. PURPOSE (NON-NEGOTIABLE)

This system determines how much influence a user's vote carries based on historical correctness and risk behavior, not activity, tenure, or XP. It feeds the existing Vote Weight System (§9) but never overrides pricing rules.

### 1. CORE PRINCIPLES

1. **Trust Is Earned, Not Claimed** — No manual roles, whitelists, or "expert" labels.
2. **Trust Is Directionally Judged** — A vote is correct only if its directional belief aligns with the final outcome of a completed cycle.
3. **Trust Is Brick-Agnostic** — Trust is global to the user, not per brick.
4. **Trust Is Slowly Accretive, Quickly Risk-Limited** — Gains are gradual; losses are capped, dampened, and reversible.
5. **Trust Never Guarantees Dominance** — All weight is clamped (§9), regardless of trust tier.

### 2. TRUST AS A FIRST-CLASS STATE (WORKER-OWNED)

**Authoritative Table: user_trust_state**

```sql
CREATE TABLE user_trust_state (
  user_id UUID PRIMARY KEY,
  trust_score FLOAT NOT NULL DEFAULT 0.0, -- [-1.0, +1.0]
  trust_tier ENUM('UNTRUSTED', 'PROBATION', 'NEUTRAL', 'RELIABLE', 'PROVEN') NOT NULL DEFAULT 'UNTRUSTED',
  total_scored_votes INTEGER NOT NULL DEFAULT 0,
  aligned_votes INTEGER NOT NULL DEFAULT 0,
  misaligned_votes INTEGER NOT NULL DEFAULT 0,
  last_scored_cycle_id UUID NULL,
  last_trust_update TIMESTAMP NULL,
  abuse_flag_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TIMESTAMP NULL
);
```

**Rules:**

- ❌ No client writes
- ❌ No client reads (except tier label if exposed later)
- ✅ Updated only by Trust Evaluation Worker
- ✅ Fully reconstructable from event logs

### 3. WHAT COUNTS AS A "SCORED VOTE"

A vote becomes scorable only when a pricing cycle closes (§21).

**Eligibility:**
A vote_event is scorable if ALL are true:

- user was logged in
- email verified (§5.3)
- vote occurred before cycle close
- vote weight at time of vote > 0
- vote was not during freeze (§23.2)

**Directional Alignment:**

- vote_direction ∈ {UNDER, OVER}
- cycle_outcome ∈ {UP, DOWN}
- Mapping: OVER aligns with UP, UNDER aligns with DOWN
- FAIR is never scored (neutral, ignored)

### 4. TRUST SCORE CALCULATION (LOCKED)

**Raw Accuracy Ratio:**

```
accuracy = aligned_votes / (aligned_votes + misaligned_votes)
If total_scored_votes < 10 → accuracy undefined → treated as neutral.
```

**Trust Score Mapping:**

```
trust_score = clamp((accuracy - 0.5) * 2, -1.0, +1.0)
```

Meaning:

- 0.50 accuracy → trust_score = 0
- 0.75 accuracy → trust_score = +0.5
- 1.00 accuracy → trust_score = +1.0
- <50% accuracy → negative trust

### 5. TRUST TIERS (LOCKED)

| Tier      | trust_score range | Meaning                   |
| --------- | ----------------- | ------------------------- |
| UNTRUSTED | < -0.25           | Consistently incorrect    |
| PROBATION | -0.25 → -0.05     | Weak or risky             |
| NEUTRAL   | -0.05 → +0.20     | Baseline                  |
| RELIABLE  | +0.20 → +0.60     | Historically aligned      |
| PROVEN    | > +0.60           | Strong signal contributor |

Tier changes occur only after cycle close scoring.

### 6. TRUST → WEIGHT MULTIPLIER (INTEGRATES §9)

| Tier      | Multiplier |
| --------- | ---------- |
| UNTRUSTED | 0.50       |
| PROBATION | 0.75       |
| NEUTRAL   | 1.00       |
| RELIABLE  | 1.10       |
| PROVEN    | 1.20       |

Final weight remains:

```
final_weight = base_account_age_weight × trust_tier_multiplier × behavior_multiplier
final_weight = clamp(final_weight, 0.0, 1.25)
```

### 7. ANTI-DOMINANCE SAFEGUARDS (LOCKED)

**Per-Cycle Influence Cap:**
Regardless of trust tier:

- A single user may not contribute more than 15% of weighted_total within a cycle.
- Excess weight is silently clipped, not rejected.

**Cooldown Trigger:**
If misaligned_votes ≥ 3 in last 5 scored votes:

- cooldown_until = now() + 72 hours
- trust_tier forced to PROBATION temporarily
- vote weight allowed but dampened via multiplier

### 8. DETERMINISM & REPLAY GUARANTEE

- Trust updates occur only at cycle close
- All inputs derive from vote_events and cycle boundaries
- Replaying events yields identical trust states

---

## APPENDIX G: TRUST EVALUATION WORKER (PSEUDOCODE)

**Purpose:** Process each cycle close once, score users' directional votes, update user_trust_state, and emit trust_score_events.

**Job Acquisition Loop:**

1. Ensure a trust job exists for every new cycle close event
2. Claim exactly one PENDING job atomically
3. Process job cycleCloseEventId
4. Mark job DONE or FAILED

**process_cycle_close(cycleCloseEventId) — Exact Order:**

**Step A — Load close event**

- Load cycle close event row
- Extract brick_id, cycle_id, outcome, closed_at

**Step B — Determine scoring-eligible votes**

- Pull all candidate votes for this brick+cycle
- Exclude votes that occurred during freeze windows
- Reduce to one vote per user_id (last non-FAIR vote)

**Step C — Score alignment**

- Define alignment function: aligned(vote_type, outcome)
- If outcome == 'FLAT': mark job DONE immediately (no scoring)

**Step D — Emit trust_score_events**

- For each (user_id, vote) in lastVotePerUser:
  - INSERT INTO trust_score_events (append-only, idempotent)

**Step E — Update user_trust_state**

- For each impacted user_id:
  - Compute updated lifetime counters
  - Compute accuracy
  - Compute trust_score
  - Assign tier from trust_score
  - Cooldown logic (rolling window)
  - Write state

**Step F — Mark job done**

---

## APPENDIX H: RECHECK WORKER — PSEUDOCODE

**Purpose:**

- Decide when a brick needs re-evaluation (needs_recheck=true)
- Create/refresh recheck windows
- Provide deterministic, auditable triggers

**Entry Point:**

- Run hourly (or daily)
- Acquire global lock
- Process bricks in pages

**Per-Brick Logic:**

1. If in recheck cooldown, skip
2. If needs_recheck already true AND window not expired, do nothing
3. If needs_recheck true BUT expired, clear it
4. Evaluate triggers in priority order:
   - PRIORITY 1: Freeze timeout / freeze exit
   - PRIORITY 2: Stale confidence
   - PRIORITY 3: Low participation / inactivity
   - PRIORITY 4: External divergence (Phase 2 - stub)
   - PRIORITY 5: Manual admin trigger

**Triggers:**

- freeze_should_trigger_recheck: freeze_until passed OR freeze older than max days
- stale_confidence_trigger: last_confidence_timestamp older than STALE_DAYS
- low_participation_trigger: no votes recently OR weighted_total too low

**Actions:**

- activate_recheck: set needs_recheck=true, recheck_state, recheck_reason, recheck_expires_at
- clear_recheck_flag: set needs_recheck=false, clear recheck fields

---

## FINAL NOTES

This specification is **LOCKED** and must be implemented exactly as written. All systems are deterministic and auditable. The trust system enables behavioral weighting without manual intervention. The recheck system prevents stale pricing without forcing endless revoting.
