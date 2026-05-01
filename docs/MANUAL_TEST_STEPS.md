# Manual Test Steps (Node) — Copy-Paste

Run these commands one by one in separate terminals. Verify logic according to SPECIFICATION.md / CLARIFICATIONS.md.

---

## Step 1: Setup (First Time)

```bash
cd bearbrick-backend
cp .env.example .env
# Set DATABASE_URL, JWT_SECRET in .env
npm install
npx prisma migrate dev
npm run db:seed
```

---

## Step 2: Start Server

**Terminal 1:**

```bash
cd bearbrick-backend
npm run dev
```

Server will run at `http://localhost:3000`.

---

## Step 3: Get Brick ID (Tinker-like)

**Terminal 2:**

```bash
cd bearbrick-backend
node scripts/inspect-db.js brick-id
```

Copy the UUID that appears. This is your `BRICK_ID`.

Or in one line:

```bash
node -e "require('dotenv').config(); const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient(); p.brickPriceState.findFirst().then(s => { console.log(s.brickId); p.\$disconnect(); });"
```

---

## Step 4: Login and Get Token

**Terminal 2:**

```bash
curl -s -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123"}' | jq
```

Copy `data.token` from the response:

```bash
export TOKEN="paste_your_token_here"
```

---

## Step 5: Test API

### 5.1 Get User Info

```bash
curl -s -X GET http://localhost:3000/api/me \
  -H "Authorization: Bearer $TOKEN" | jq
```

### 5.2 Get Brick State (brick_id from Step 3)

```bash
export BRICK_ID="your_brick_id_here"
curl -s -X GET "http://localhost:3000/api/bricks/$BRICK_ID/state" | jq
```

### 5.3 Create Vote Intent

```bash
curl -s -X POST http://localhost:3000/api/vote_intents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"brick_id\":\"$BRICK_ID\",\"vote_type\":\"OVER\"}" | jq
```

On success, you'll see `"status": "ACCEPTED"` and `intent_id`.

---

## Step 6: Run Workers (Spec Appendix B)

**Terminal 3:**

```bash
cd bearbrick-backend
npm run worker:enrich
```

Output: `Processed X vote intents.`

**Terminal 4:**

```bash
cd bearbrick-backend
npm run worker:aggregate
```

Output: `Processed X vote events.`

---

## Step 7: Check Brick State Again (With Sentiment)

```bash
curl -s -X GET "http://localhost:3000/api/bricks/$BRICK_ID/state" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Now `p_under`, `p_fair`, `p_over`, `pricing_confidence_c` will be present (after voting).

---

## Step 8: Verify with Database (Tinker-like)

```bash
node scripts/inspect-db.js
```

Or detailed:

```bash
node scripts/inspect-db.js stats
node scripts/inspect-db.js state
node scripts/inspect-db.js intents
node scripts/inspect-db.js events
```

---

## One-Line Quick Test

With server running, after setting `TOKEN` and `BRICK_ID`:

```bash
curl -s -X POST http://localhost:3000/api/vote_intents -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"brick_id\":\"$BRICK_ID\",\"vote_type\":\"FAIR\"}" | jq
npm run worker:enrich
npm run worker:aggregate
curl -s -X GET "http://localhost:3000/api/bricks/$BRICK_ID/state" -H "Authorization: Bearer $TOKEN" | jq
```

---

## Troubleshooting

| Issue              | Solution                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `jq` not installed | `sudo apt install jq` or remove `\| jq` from commands             |
| Login 401          | Check email: `admin@example.com`, password: `password123`         |
| Route not found    | Check if `npm run dev` is running in Terminal 1                   |
| Brick not found    | Run Step 3 again to get correct brick_id                          |
| No pending intents | Run Step 5.3 again to create new vote                             |
| No credits         | Reset credits with `node scripts/reset-credits.js` (testing only) |

For more details, see [LOCAL_TESTING.md](./LOCAL_TESTING.md).
