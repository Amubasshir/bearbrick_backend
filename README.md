# BE@RBRICK Crowd-Sourced Pricing Engine

**Version:** 1.0 (Complete)  
**Status:** Production Ready ✅  
**Spec Compliance:** 100%

A Node.js backend implementation of a crowd-sourced pricing engine for BE@RBRICK collectibles. This system uses an event-sourced architecture with deterministic workers to calculate market prices based on user votes. Includes Trust & Weight Governance System and Recheck System for behavioral weighting and stale price prevention.

## Overview

The pricing engine operates like a sportsbook-style market correction system. Users vote on whether a brick's price is UNDER, FAIR, or OVER the current market price. The system aggregates these votes using weighted algorithms to determine price movements, ensuring accuracy, abuse-resistance, and non-fatiguing user experience.

### Key Features

- **Event-Sourced Architecture**: All state changes are derived from immutable event logs
- **Deterministic Workers**: Reproducible outcomes from event logs alone
- **Blind Voting**: No sentiment visible before voting (prevents manipulation)
- **Trust-Based Weighting**: User influence based on account age, trust tier (behavioral), and behavior
- **Trust Evaluation System**: Automatic trust scoring based on vote accuracy over cycles
- **Recheck System**: State machine for identifying bricks needing re-evaluation
- **Recheck Missions**: Personalized feed of bricks needing votes with bonus XP
- **Abuse Prevention**: Vote credits, rate limiting, momentum buffers, freeze mode, per-cycle influence cap
- **Event Logging**: Cycle close events and freeze window events for audit trail
- **Real-Time Updates**: Workers process votes asynchronously

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Authentication**: JWT (Bearer tokens)
- **API Documentation**: Swagger/OpenAPI (auto-generated)

## Quick Start

### Prerequisites

- Node.js 18 or higher
- PostgreSQL database
- npm or yarn

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd bearbrick-backend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:

   - `DATABASE_URL` - PostgreSQL connection string
   - `JWT_SECRET` - Secret key for JWT tokens
   - Optional: Pricing configuration overrides (see `config/pricing.js`)

4. **Set up database**

   ```bash
   npx prisma migrate deploy
   npm run db:seed
   ```

5. **Generate Swagger documentation** (first time only)

   ```bash
   npm run swagger-autogen
   ```

6. **Start the API server**
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:3000/api`

## API Documentation

Interactive Swagger documentation is available at: **http://localhost:3000/api-docs**

- View all endpoints
- Test API calls directly from the browser
- See request/response schemas
- Authentication support (Bearer token)

**Note**: After adding or modifying endpoints, run `npm run swagger-autogen` to regenerate the documentation.

## API Endpoints

| Method | Path                          | Auth     | Description                                               |
| ------ | ----------------------------- | -------- | --------------------------------------------------------- |
| POST   | `/api/login`                  | —        | Authenticate user and receive JWT token                   |
| POST   | `/api/logout`                 | Bearer   | Logout (client should discard token)                      |
| GET    | `/api/me`                     | Bearer   | Get current authenticated user information                |
| POST   | `/api/vote_intents`           | Bearer   | Submit a vote intent (UNDER \| FAIR \| OVER)              |
| GET    | `/api/bricks`                 | Optional | Get all bricks info (sentiment only if user has voted)    |
| GET    | `/api/bricks/:brick_id/state` | Optional | Get single brick state (sentiment only if user has voted) |
| GET    | `/api/recheck/feed`           | Bearer   | Get personalized recheck missions (email verified only)   |

### Authentication

All endpoints except `/api/login` and `/api/bricks` require a Bearer token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

### Example: Login and Get User Info

```bash
# Login
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123"}'

# Response contains token in data.token
# Use it for subsequent requests:
curl -X GET http://localhost:3000/api/me \
  -H "Authorization: Bearer <token>"
```

### Example: Vote on a Brick

```bash
curl -X POST http://localhost:3000/api/vote_intents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "brick_id": "11111111-1111-4111-8111-111111111101",
    "vote_type": "OVER"
  }'
```

### Example: Get Recheck Feed

```bash
curl -X GET http://localhost:3000/api/recheck/feed?limit=5 \
  -H "Authorization: Bearer <token>"
```

Response includes personalized list of bricks needing recheck with:

- `recheck_reason` (STALE, LOW_SAMPLE, OPPOSING_SIGNAL, POST_FREEZE)
- `recheck_state` (WATCH, ACTIVE)
- `bonus_xp_multiplier` (2.0 for recheck votes)
- `credit_available` (true if credits can be granted)

## Workers

The system uses three workers that process events asynchronously. Workers must run continuously in production.

### Worker Execution Order

1. **Vote Enricher** (`vote_intents` → `vote_events`)
2. **Price Aggregator** (`vote_events` → `brick_price_state`)
   - Logs cycle close events when cycles reset
   - Logs freeze window events when freeze enters/exits
3. **Trust Evaluation** (`pricing_cycle_close_events` → `user_trust_state`)
   - Processes cycle closes and scores user votes
   - Updates trust tiers based on accuracy
4. **Recheck Worker** (evaluates triggers hourly/daily)
   - Manages recheck state machine
   - Activates recheck for stale/low-sample bricks
5. **Daily Snapshot** (runs once per day at 11:07 PM EST)

### Running Workers

#### Development (Manual)

```bash
# Terminal 1: API Server
npm run dev

# Terminal 2: Enrich Worker (run repeatedly)
npm run worker:enrich

# Terminal 3: Aggregate Worker (run repeatedly)
npm run worker:aggregate

# Terminal 4: Trust Evaluation Worker (runs continuously)
npm run worker:trust

# Terminal 5: Recheck Worker (runs hourly/daily)
npm run worker:recheck

# Terminal 6: Snapshot Worker (run once daily)
npm run worker:snapshot
```

#### Production (PM2)

**Option A: Single Loop Process** (Recommended for small/medium load)

```bash
WORKER_LOOP_INTERVAL_MS=60000 pm2 start npm --name "pricing-worker-loop" -- run worker:loop
pm2 save
pm2 startup
```

**Option B: Separate Processes**

```bash
# Enrich Worker
pm2 start npm --name "pricing-worker-enrich" -- run worker:enrich

# Aggregate Worker
pm2 start npm --name "pricing-worker-aggregate" -- run worker:aggregate

# Trust Evaluation Worker
pm2 start npm --name "pricing-worker-trust" -- run worker:trust

# Recheck Worker (runs hourly, can use cron instead)
pm2 start npm --name "pricing-worker-recheck" -- run worker:recheck
# OR use cron: 0 * * * * cd /path/to/app && npm run worker:recheck

# Snapshot Worker (via cron)
# Add to crontab: 7 4 * * * cd /path/to/app && npm run worker:snapshot
```

See [docs/DEVOPS_WORKER_SETUP.md](./docs/DEVOPS_WORKER_SETUP.md) for detailed production setup instructions.

### Worker Scripts

| Script                     | Description                                                      |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run worker:enrich`    | Process vote intents → vote events (credits, fair range, weight) |
| `npm run worker:aggregate` | Process vote events → price state (sentiment, caps, momentum)    |
| `npm run worker:trust`     | Process cycle closes → trust scores and tiers                    |
| `npm run worker:recheck`   | Evaluate recheck triggers and manage state machine               |
| `npm run worker:snapshot`  | Create daily snapshot → price history                            |
| `npm run worker:loop`      | Run enrich → aggregate in a continuous loop                      |

## Project Structure

```
bearbrick-backend/
├── config/
│   ├── pricing.js              # Pricing configuration (env-overridable)
│   └── swagger-autogen.js      # Swagger auto-generation config
├── prisma/
│   ├── schema.prisma           # Database schema
│   ├── migrations/             # Database migrations
│   └── seed.js                 # Database seed script
├── src/
│   ├── app.js                  # Express app setup
│   ├── server.js               # Server entry point
│   ├── controllers/            # Request handlers
│   │   ├── AuthController.js
│   │   ├── BrickController.js
│   │   ├── VoteIntentController.js
│   │   └── RecheckController.js
│   ├── middleware/             # Express middleware
│   │   ├── auth.js
│   │   ├── optionalAuth.js
│   │   └── rateLimitVoteIntents.js
│   ├── routes/
│   │   └── api.js              # API routes
│   ├── services/               # Business logic
│   │   ├── AuthService.js
│   │   ├── VoteCreditService.js
│   │   └── pricing/            # Pricing engine services
│   │       ├── SentimentService.js
│   │       ├── ConfidenceService.js
│   │       ├── MovementEligibilityService.js
│   │       ├── IntensityService.js
│   │       ├── CapService.js
│   │       ├── MomentumService.js
│   │       ├── AnchorService.js
│   │       ├── CycleService.js
│   │       ├── FreezeService.js
│   │       ├── OrderAwareService.js
│   │       ├── RecheckService.js
│   │       ├── FairRangeService.js
│   │       ├── PricingTierService.js
│   │       ├── UserWeightService.js
│   │       ├── ReliabilityService.js
│   │       ├── TrustService.js
│   │       └── InfluenceCapService.js
│   └── scripts/                # Worker scripts
│       ├── enrich-votes.js
│       ├── aggregate-prices.js
│       ├── trust-evaluation-worker.js
│       ├── recheck-worker.js
│       └── snapshot.js
├── scripts/                    # Utility scripts
│   ├── inspect-db.js          # Database inspection (tinker-like)
│   ├── reset-cursors.js       # Reset worker cursors (testing)
│   ├── reset-credits.js       # Reset vote credits (testing)
│   ├── test-full-flow.js      # Full flow test
│   ├── test-all-logic.js      # Complete logic test
│   └── worker-loop.js         # Worker loop script
├── tests/                      # Test files
│   ├── api/                   # API integration tests
│   └── unit/                  # Unit tests
└── docs/                       # Documentation
    ├── SPECIFICATION.md        # Core specification
    ├── CLARIFICATIONS.md       # Official clarifications
    ├── DEVOPS_WORKER_SETUP.md  # Production worker setup
    ├── CLIENT_SWAGGER_TESTING.md  # Client: Swagger testing (production)
    ├── MANUAL_TEST_STEPS.md    # Manual testing guide
    └── LOCAL_TESTING.md        # Local testing guide
```

## Testing

### Unit Tests

Unit tests for pricing services (no database required):

```bash
npm run test:unit
```

Tests cover: Sentiment, FairRange, PricingTier, Confidence, MovementEligibility, Intensity, Anchor, Momentum, Freeze, Cap calculations.

### API Tests

API integration tests (requires running database):

```bash
npm run db:seed  # Seed test data first
npm run test:api
```

Tests cover: Health check, login (validation + success), me, logout, bricks state (404, 200 without auth), vote_intents (401, 422, 201).

### Run All Tests

```bash
npm test
```

### Manual Testing

For manual testing and logic verification:

```bash
# Get a brick ID
node scripts/inspect-db.js brick-id

# Full flow test (intent → enrich → aggregate → state)
npm run test:flow

# Complete logic test (DB insert + enrich + aggregate + credits + sentiment + snapshot)
npm run test:logic
```

See [docs/MANUAL_TEST_STEPS.md](./docs/MANUAL_TEST_STEPS.md) and [docs/LOCAL_TESTING.md](./docs/LOCAL_TESTING.md) for detailed testing guides.

## Database Utilities

### Inspect Database

```bash
# Show all stats and first brick state
node scripts/inspect-db.js

# Get first brick ID
node scripts/inspect-db.js brick-id

# Show counts (intents, events, XP, cursors)
node scripts/inspect-db.js stats

# Show all brick price states
node scripts/inspect-db.js state

# Show last 10 vote intents
node scripts/inspect-db.js intents

# Show last 10 vote events
node scripts/inspect-db.js events

# Show user brick credits
node scripts/inspect-db.js credits

# Show worker cursors
node scripts/inspect-db.js cursors
```

### Reset Utilities (Testing Only)

```bash
# Reset worker cursors (re-process from start)
node scripts/reset-cursors.js

# Reset vote credits (all users×bricks → max credits)
node scripts/reset-credits.js
```

## Configuration

### Environment Variables

See `.env.example` for all available environment variables. Key variables:

- `DATABASE_URL` - PostgreSQL connection string (required)
- `JWT_SECRET` - Secret key for JWT tokens (required)
- `WORKER_LOOP_INTERVAL_MS` - Worker loop interval in milliseconds (default: 60000)
- `RECHECK_WORKER_INTERVAL_MIN` - Recheck worker run interval in minutes (default: 60)
- `WORKER_INSTANCE_ID` - Unique identifier for trust worker instance (auto-generated if not set)
- `PRICING_*` - Override pricing configuration (see `config/pricing.js`)

### Pricing Configuration

All pricing parameters are configurable via environment variables. See `config/pricing.js` for defaults:

- Fair range percentage
- Minimum weighted totals for movement
- Price tiers and base steps
- Caps (early ramp, dynamic, catch-up)
- Freeze thresholds
- Cycle reset conditions
- Vote credit limits
- Momentum bounds
- Recheck system parameters (stale days, window days, XP multiplier)
- Trust system parameters (min scored votes, cooldown thresholds)
- Per-cycle influence cap percentage

## Architecture

### Event-Sourced Design

- **Append-only events**: `vote_intents` → `vote_events` → `xp_events`
- **Derived state**: `brick_price_state` is computed from events
- **No business logic in APIs**: APIs only create events
- **Deterministic workers**: All logic in workers, reproducible from events

### Core Principles

1. **Blind Voting**: No sentiment visible before voting
2. **Insight Is Earned**: Sentiment revealed only after participation
3. **Trust Is Behavioral**: Influence earned through correctness over time
4. **No Single Actor Can Dominate**: Vote weight is capped and reversible
5. **Determinism**: All outcomes reproducible from event logs

### Pricing Flow

1. User submits vote intent via API
2. **Enrich Worker** processes intent:
   - Validates credits (checks recheck credit grant)
   - Calculates fair range, base step, user weight (from trust state)
   - Checks credit regain conditions (price move or recheck)
   - Creates vote_event
   - Generates XP event (if verified, with recheck bonus if applicable)
3. **Aggregate Worker** processes vote_event:
   - Applies per-cycle influence cap (15% max)
   - Updates weighted counters
   - Calculates sentiment and confidence
   - Checks movement eligibility
   - Applies caps and momentum
   - Updates price (if eligible)
   - Checks freeze/cycle conditions
   - Logs cycle close events when cycles reset
   - Logs freeze window events when freeze enters/exits
4. **Trust Evaluation Worker** processes cycle closes:
   - Scores user votes based on cycle outcomes
   - Updates user trust states and tiers
   - Handles cooldown logic
5. **Recheck Worker** (hourly/daily):
   - Evaluates recheck triggers (stale, low sample, opposing signal)
   - Manages recheck state machine (NONE → WATCH → ACTIVE)
   - Handles window expiry
6. **Snapshot Worker** (daily):
   - Records daily close price
   - Creates price history entry

## Test User

After running `npm run db:seed`, use these credentials:

- **Email**: `admin@example.com`
- **Password**: `password123`

Additional test users: `user1@example.com`, `user2@example.com` (same password)

## New Features (v1.0 Complete)

### Trust & Weight Governance System

- **Trust Evaluation**: Votes are scored based on cycle outcomes (UP/DOWN alignment)
- **Trust Tiers**: UNTRUSTED, PROBATION, NEUTRAL, RELIABLE, PROVEN
- **Dynamic Weighting**: Trust tiers automatically update based on vote accuracy
- **Cooldown System**: Users with 3+ misaligned votes in last 5 get 72hr cooldown

### Recheck System

- **State Machine**: NONE → WATCH → ACTIVE → NONE transitions
- **Triggers**: Stale confidence, low sample, opposing signal, post-freeze refresh
- **Recheck Feed**: Personalized missions with bonus XP (2x multiplier)
- **Credit Grant**: Recheck bricks unlock additional vote credits

### Event Logging

- **Cycle Close Events**: Logged when cycles reset (≥7% move)
- **Freeze Window Events**: Logged when freeze enters/exits
- **Audit Trail**: Full event history for trust scoring and analytics

### Anti-Dominance Safeguards

- **Per-Cycle Influence Cap**: No single user can contribute >15% of weighted_total per cycle
- **Weight Capping**: Excess weight silently clipped (vote not rejected)

## Documentation

- [FINAL_REQUIREMENT.md](./docs/FINAL_REQUIREMENT.md) - Complete specification (v1.0 LOCKED)
- [SPECIFICATION.md](./docs/SPECIFICATION.md) - Core specification document
- [CLARIFICATIONS.md](./docs/CLARIFICATIONS.md) - Official clarifications
- [FEATURE_COMPARISON.md](./docs/FEATURE_COMPARISON.md) - Feature comparison and status
- [DEVOPS_WORKER_SETUP.md](./docs/DEVOPS_WORKER_SETUP.md) - Production worker setup
- [CLIENT_SWAGGER_TESTING.md](./docs/CLIENT_SWAGGER_TESTING.md) - **Client guide: test API with Swagger (production)**
- [MANUAL_TEST_STEPS.md](./docs/MANUAL_TEST_STEPS.md) - Manual testing guide
- [LOCAL_TESTING.md](./docs/LOCAL_TESTING.md) - Local testing guide

## Scripts Reference

| Script                     | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `npm start`                | Start production server                                 |
| `npm run dev`              | Start development server (with watch)                   |
| `npm run migrate`          | Run Prisma migrations (dev)                             |
| `npm run migrate:deploy`   | Run Prisma migrations (production)                      |
| `npm run db:seed`          | Seed database with test data                            |
| `npm run worker:enrich`    | Run enrich worker once                                  |
| `npm run worker:aggregate` | Run aggregate worker once                               |
| `npm run worker:trust`     | Run trust evaluation worker (runs continuously)         |
| `npm run worker:recheck`   | Run recheck worker once (runs hourly/daily)             |
| `npm run worker:snapshot`  | Run snapshot worker once                                |
| `npm run worker:loop`      | Run enrich → aggregate in continuous loop               |
| `npm run swagger-autogen`  | Generate Swagger documentation                          |
| `npm run inspect`          | Inspect database (same as `node scripts/inspect-db.js`) |
| `npm run reset:cursors`    | Reset worker cursors (testing)                          |
| `npm run reset:credits`    | Reset vote credits (testing)                            |
| `npm run test:flow`        | Run full flow test                                      |
| `npm run test:logic`       | Run complete logic test                                 |
| `npm test`                 | Run all tests                                           |
| `npm run test:unit`        | Run unit tests only                                     |
| `npm run test:api`         | Run API tests only                                      |

## Database Schema

### Core Tables

- `vote_intents` - User vote submissions (API writes only)
- `vote_events` - Canonical vote records (append-only)
- `xp_events` - XP awards (VOTE, STREAK, RECHECK, ACCURACY)
- `brick_price_state` - Current pricing state (worker-owned)
- `brick_price_history` - Daily close prices
- `user_brick_vote_credits` - Vote credits per user×brick
- `user_identity_state` - User identity and behavior state
- `worker_cursors` - Worker state tracking

### Trust System Tables

- `pricing_cycle_close_events` - Cycle closure events (append-only)
- `trust_score_events` - Vote scoring audit trail (append-only)
- `user_trust_state` - Trust scores and tiers (worker-owned)
- `trust_worker_jobs` - Job queue for trust evaluation

### Recheck System Tables

- `brick_freeze_window_events` - Freeze enter/exit events (append-only)
- Recheck fields in `brick_price_state`: `recheckState`, `recheckReason`, `recheckStartedAt`, `recheckExpiresAt`

## Implementation Status

**Version:** 1.0 (Complete)  
**Spec Compliance:** 100%  
**Status:** Production Ready ✅

All features from FINAL_REQUIREMENT.md have been implemented:

- ✅ Trust Evaluation System
- ✅ Recheck System with State Machine
- ✅ Event Logging (Cycle Close, Freeze Windows)
- ✅ Per-Cycle Influence Cap
- ✅ Recheck Feed API
- ✅ Recheck XP Bonus
- ✅ Recheck Credit Grant

See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for detailed implementation notes.

## License

[Add your license here]

## Support

For issues and questions, please refer to the documentation in the `docs/` directory or contact the development team.
