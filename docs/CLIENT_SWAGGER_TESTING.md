# Client Guide: Testing the API with Swagger

This guide is for **clients** who want to test the BE@RBRICK Pricing Engine API on the **production server** using the interactive Swagger UI.

---

## 1. What This App Does (Brief)

- **Pricing Engine API**: Users can log in, see bricks (items), cast votes (UNDER / FAIR / OVER) on a brick’s price, and then see that brick’s **sentiment** (p_under, p_fair, p_over) and **pricing confidence** only **after** they have voted.
- The API is already deployed on the **production server**. You will use the **same base URL** for Swagger and for all API calls (e.g. `https://your-api.example.com` — replace with the real URL you were given).

---

## 2. Open Swagger UI on Production

1. In your browser, go to:

   ```
   https://YOUR_PRODUCTION_BASE_URL/api-docs
   ```

   Replace `YOUR_PRODUCTION_BASE_URL` with the actual host (e.g. `api.bearbrick.com` or `your-server.com`).  
   Example: `https://api.bearbrick.com/api-docs`

2. You should see the **Swagger UI** page with all API endpoints listed.

---

## 3. Testing Flow (Step by Step)

Follow these steps **in order** to: log in → get a brick ID → submit a vote → see the brick state (including sentiment after you voted).

---

### Step 1: Log In and Get a Token

1. Find **POST /api/login** in Swagger.
2. Click **Try it out**.
3. In the **Request body**, use valid credentials (provided by your team). Example:
   ```json
   {
     "email": "admin@example.com",
     "password": "password123"
   }
   ```
4. Click **Execute**.
5. In the **Response body**, copy the **token** from `data.token` (the long string starting with `eyJ...`).

**Authorize in Swagger (required for vote and protected endpoints):**

6. At the **top** of the Swagger page, click **Authorize**.
7. In the **Value** field, type:
   ```
   Bearer PASTE_YOUR_TOKEN_HERE
   ```
   (Replace `PASTE_YOUR_TOKEN_HERE` with the token you copied; keep the word `Bearer` and a space before the token.)
8. Click **Authorize**, then **Close**.

All subsequent requests that need authentication will use this token automatically.

---

### Step 2: Get Brick IDs — GET /api/bricks

1. Find **GET /api/bricks** in Swagger.
2. Click **Try it out**.
3. (No path or body parameters needed. If you are logged in via Authorize, the request will send your token.)
4. Click **Execute**.
5. In the **Response body**, you will see a list of bricks in `data`. Each item has a **brick_id** (a UUID).  
   **Copy one `brick_id`** — you will use it to vote and then to fetch that brick’s state.

Example response shape:

```json
{
  "success": true,
  "data": [
    {
      "brick_id": "11111111-1111-4111-8111-111111111101",
      "live_price": 100,
      "fair_lower": 95,
      "fair_upper": 105,
      "freeze_mode": false,
      "current_cycle_id": "...",
      "last_price_update": "...",
      "last_vote_event_id_processed": 0
    }
  ]
}
```

If you have already voted on a brick, that brick’s object may also include `p_under`, `p_fair`, `p_over`, and `pricing_confidence_c`.

---

### Step 3: Submit a Vote — POST /api/vote_intents

1. Find **POST /api/vote_intents** in Swagger.
2. Click **Try it out**.
3. In the **Request body**, use the **brick_id** you copied in Step 2 and choose a **vote_type**:
   ```json
   {
     "brick_id": "11111111-1111-4111-8111-111111111101",
     "vote_type": "OVER"
   }
   ```
   - **vote_type** must be one of: **UNDER**, **FAIR**, **OVER**.
4. Click **Execute**.
5. You should get a **201** response with something like:
   ```json
   {
     "success": true,
     "message": "Vote intent accepted",
     "data": { "status": "ACCEPTED", "intent_id": 12345 }
   }
   ```
   This means your vote was accepted. In the background, workers process it; after they run, the brick’s state (and sentiment) will update.

---

### Step 4: See Brick State (Including Sentiment After Vote) — GET /api/bricks/:brick_id/state

1. Find **GET /api/bricks/{brick_id}/state** in Swagger.
2. Click **Try it out**.
3. In the **brick_id** path parameter, paste the **same brick_id** you used when voting.
4. Click **Execute**.
5. In the **Response body** you will see that brick’s current state.

Because you have voted on this brick, the response will **include sentiment and confidence** for you:

- **p_under**, **p_fair**, **p_over** — sentiment percentages
- **pricing_confidence_c** — pricing confidence

Example (after voting):

```json
{
  "brick_id": "11111111-1111-4111-8111-111111111101",
  "live_price": 100,
  "fair_lower": 95,
  "fair_upper": 105,
  "freeze_mode": false,
  "current_cycle_id": "...",
  "last_price_update": "...",
  "last_vote_event_id_processed": 42,
  "p_under": 0.2,
  "p_fair": 0.5,
  "p_over": 0.3,
  "pricing_confidence_c": 0.6
}
```

**Note:** Sentiment and confidence appear only **after** you have voted on that brick and the backend workers have processed your vote. If you call this endpoint immediately after POST /api/vote_intents, you may need to wait a short time and call it again, or try another brick you voted on earlier.

---

## 4. Quick Reference — Order of Calls

| Step | Method | Path                        | Purpose                                                                           |
| ---- | ------ | --------------------------- | --------------------------------------------------------------------------------- |
| 1    | POST   | /api/login                  | Get token, then use **Authorize** with `Bearer <token>`                           |
| 2    | GET    | /api/bricks                 | Get list of bricks; copy a **brick_id**                                           |
| 3    | POST   | /api/vote_intents           | Send vote: body `{ "brick_id": "...", "vote_type": "UNDER" \| "FAIR" \| "OVER" }` |
| 4    | GET    | /api/bricks/:brick_id/state | See that brick’s state and (after voting) sentiment/confidence                    |

---

## 5. Troubleshooting

- **401 Unauthorized** on POST /api/vote_intents or GET /api/me  
  → You must **Authorize** first:

  1. Copy token from POST /api/login response (`data.token`)
  2. Click **Authorize** button at the top of Swagger UI
  3. In the **Value** field, enter: `Bearer YOUR_TOKEN_HERE` (include the word "Bearer" and a space before your token)
  4. Click **Authorize**, then **Close**
  5. Try your request again — you should see a 🔒 lock icon next to protected endpoints

- **Token not working / Still getting 401 after Authorize**  
  → Make sure you entered the **full value**: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (with "Bearer " prefix and space).  
  → Verify the token is not expired (login again to get a new token).  
  → Check that you clicked **Authorize** and then **Close** (don't just type and leave).

- **404 Brick not found** on GET /api/bricks/:brick_id/state  
  → Use a **brick_id** that exists in GET /api/bricks response.

- **422 Validation error** on POST /api/vote_intents  
  → Check that **brick_id** is a non-empty string and **vote_type** is exactly one of: UNDER, FAIR, OVER.

- **Sentiment not visible** on GET /api/bricks/:brick_id/state  
  → Sentiment is shown only for bricks you have voted on. Ensure you are logged in (Authorize) and that workers have processed your vote (wait a bit and try again if needed).

---

## 6. Production Base URL

Use the **exact base URL** your team provided for the deployed API. All paths in this guide are relative to that base, for example:

- Swagger UI: `https://YOUR_BASE_URL/api-docs`
- Login: `https://YOUR_BASE_URL/api/login`
- Bricks: `https://YOUR_BASE_URL/api/bricks`
- Vote: `https://YOUR_BASE_URL/api/vote_intents`
- Brick state: `https://YOUR_BASE_URL/api/bricks/{brick_id}/state`

Replace `YOUR_BASE_URL` with the real production host.
