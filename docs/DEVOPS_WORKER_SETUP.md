# BE@RBRICK Crowd-Sourced Pricing Engine — Worker Setup (DevOps)

This doc is for DevOps to run the **5 workers** required by the Node.js backend (updated v1.0).

## ⚠️ Important: Production vs Development

**In Production:**

- ✅ Workers run **automatically** via PM2 or cron
- ✅ No manual intervention needed after initial setup
- ✅ Workers restart automatically if they crash
- ✅ Runs 24/7 without manual commands

**In Development:**

- Manual commands can be used for testing
- Run `npm run worker:enrich` and `npm run worker:aggregate` manually as needed

**After deployment, you only need to:**

1. **Run database migration** (Section 2.1) - **REQUIRED FIRST**
2. Set up PM2 for Enrich + Aggregate workers (Section 3 or 4)
3. Set up PM2 for Trust Evaluation Worker (Section 6) - **NEW**
4. Set up cron/PM2 for Recheck Worker (Section 7) - **NEW**
5. Set up cron for Snapshot worker (Section 5)
6. Monitor logs: `pm2 logs` or check cron logs

**You do NOT need to manually run worker commands after deployment.**

---

## 1. Overview

| Worker               | Purpose                                                                          | How to run                      |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| **Enrich**           | `vote_intents` → `vote_events` (credits, fair range, user weight)                | Run continuously (loop or PM2)  |
| **Aggregate**        | `vote_events` → `brick_price_state` (sentiment, caps, momentum, freeze, recheck) | Run continuously (loop or PM2)  |
| **Trust Evaluation** | `pricing_cycle_close_events` → `user_trust_state` (vote scoring, trust tiers)    | Run continuously (PM2)          |
| **Recheck**          | Evaluates triggers → manages recheck state machine                               | Run hourly/daily (cron/PM2)     |
| **Snapshot**         | Daily close → `brick_price_history`                                              | Once per day on schedule (cron) |

**Order:**

1. Enrich runs before Aggregate
2. Trust Evaluation processes cycle closes (independent, continuous)
3. Recheck evaluates triggers (independent, hourly/daily)
4. Snapshot is independent, run once daily

---

## 2. Prerequisites

### 2.1 Database Migration (REQUIRED FIRST)

**⚠️ IMPORTANT:** Before starting workers, run the database migration:

```bash
cd /path/to/bearbrick-backend
npx prisma migrate deploy
npx prisma generate
```

This creates new tables for Trust System and Recheck System:

- `pricing_cycle_close_events`
- `trust_score_events`
- `user_trust_state`
- `trust_worker_jobs`
- `brick_freeze_window_events`

**Migration is additive** - no data loss, safe to run on production.

### 2.2 Other Prerequisites

- Node.js 18+
- App repo cloned, `npm install` done
- `.env` configured:
  - `DATABASE_URL` (required)
  - `JWT_SECRET` (required)
  - `WORKER_LOOP_INTERVAL_MS` (optional, default: 60000)
  - `RECHECK_WORKER_INTERVAL_MIN` (optional, default: 60)
  - `WORKER_INSTANCE_ID` (optional, auto-generated)
- PostgreSQL up; migrations applied (see 2.1)
- Optional: `npm run db:seed` for test data

---

## 3. Option A — Single loop process (Enrich + Aggregate)

One process runs **enrich** then **aggregate** in a loop. Easiest for small/medium load.

**Script:** `npm run worker:loop`

- Runs: `node src/scripts/enrich-votes.js` then `node src/scripts/aggregate-prices.js`, then sleeps.
- **Env:** `WORKER_LOOP_INTERVAL_MS` (default `60000` = 1 minute).

**Run with PM2 example:**

```bash
cd /path/to/crowd-sourced-node
WORKER_LOOP_INTERVAL_MS=60000 pm2 start npm --name "pricing-worker-loop" -- run worker:loop
pm2 save
pm2 startup   # if not already done
```

**Snapshot:** Run separately on a schedule (see Section 5).

---

## 4. Option B — Separate Enrich and Aggregate processes

Run two long‑running processes: one for enrich, one for aggregate.

**Enrich:**

```bash
pm2 start npm --name "pricing-worker-enrich" -- run worker:enrich
```

**Aggregate:**

```bash
pm2 start npm --name "pricing-worker-aggregate" -- run worker:aggregate
```

Adjust restart policy / cron if you want them to run on an interval instead of 24/7 (e.g. every 1–2 min via cron calling the same npm scripts).

**Snapshot:** Run separately on a schedule (see Section 5).

---

## 5. Snapshot Worker (Daily)

Snapshot writes daily close to `brick_price_history`. Run **once per day** at a fixed time (e.g. 11:07 PM EST = 04:07 UTC next day, or as per product).

Snapshot writes daily close to `brick_price_history`. Run **once per day** at a fixed time (e.g. 11:07 PM EST = 04:07 UTC next day, or as per product).

**One-off run:**

```bash
cd /path/to/crowd-sourced-node
npm run worker:snapshot
```

**Cron example (daily at 04:07 UTC):**

```cron
7 4 * * * cd /path/to/crowd-sourced-node && npm run worker:snapshot >> /var/log/pricing-snapshot.log 2>&1
```

Replace `/path/to/crowd-sourced-node` with actual app path. Ensure cron user has correct `.env` and `node` in PATH.

### 5.1 Cron Management

**Adding/Editing Cron Jobs:**

```bash
# Edit crontab
crontab -e

# View current crontab
crontab -l

# Remove all cron jobs (careful!)
crontab -r
```

**Example Cron Entry (daily at 04:07 UTC):**

```cron
7 4 * * * cd /path/to/bearbrick-backend && npm run worker:snapshot >> /var/log/pricing-snapshot.log 2>&1
```

**Cron Syntax:**

```
* * * * * command
│ │ │ │ │
│ │ │ │ └─── Day of week (0-7, Sunday = 0 or 7)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

**Common Cron Patterns:**

- `0 * * * *` - Every hour
- `*/5 * * * *` - Every 5 minutes
- `0 0 * * *` - Daily at midnight
- `0 4 * * *` - Daily at 4 AM UTC
- `7 4 * * *` - Daily at 04:07 UTC (11:07 PM EST previous day)

**Verifying Cron:**

```bash
# Check cron service status
sudo systemctl status cron  # Ubuntu/Debian
sudo systemctl status crond  # CentOS/RHEL

# View cron logs
grep CRON /var/log/syslog  # Ubuntu/Debian
grep CRON /var/log/messages  # CentOS/RHEL

# Test cron job manually
cd /path/to/bearbrick-backend && npm run worker:snapshot
```

**Important Notes:**

- Cron runs with minimal environment variables. Set PATH and load `.env` explicitly if needed:

  ```cron
  7 4 * * * cd /path/to/bearbrick-backend && /usr/bin/node /path/to/npm run worker:snapshot >> /var/log/pricing-snapshot.log 2>&1
  ```

- Use absolute paths in cron jobs
- Ensure the cron user has read access to `.env` file
- Log output to a file for debugging

**Alternative: Using PM2 Cron (Recommended)**

PM2 supports cron-like scheduling without system cron:

```bash
# Install PM2
npm install -g pm2

# Start snapshot with PM2 cron
pm2 start npm --name "pricing-snapshot" --cron "7 4 * * *" -- run worker:snapshot

# Or use ecosystem file
pm2 start ecosystem.config.js
```

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: "pricing-snapshot",
      script: "npm",
      args: "run worker:snapshot",
      cron_restart: "7 4 * * *",
      autorestart: false,
    },
  ],
};
```

---

## 8. Summary Checklist

### Pre-Deployment

- [ ] **Database Migration:** Run `npx prisma migrate deploy` and `npx prisma generate` (REQUIRED)
- [ ] Node 18+, dependencies installed (`npm install`)
- [ ] `.env` configured with `DATABASE_URL`, `JWT_SECRET`
- [ ] PostgreSQL database accessible

### Worker Setup

- [ ] **Enrich + Aggregate:** Either `worker:loop` (Option A) or separate `worker:enrich` + `worker:aggregate` (Option B) running continuously (PM2)
- [ ] **Trust Evaluation:** `worker:trust` running continuously (PM2) - **NEW**
- [ ] **Recheck:** `worker:recheck` running hourly/daily (cron or PM2 cron) - **NEW**
- [ ] **Snapshot:** Cron (or scheduler) running `npm run worker:snapshot` once per day

### Monitoring

- [ ] Logs/monitoring for all worker processes (PM2 logs, cron log paths)
- [ ] PM2 startup script configured (`pm2 startup` + `pm2 save`)
- [ ] Cron jobs verified (`crontab -l`)

### Verification

- [ ] Check PM2 status: `pm2 list` (should show enrich/aggregate/trust workers)
- [ ] Check cron jobs: `crontab -l` (should show recheck and snapshot)
- [ ] Verify logs: `pm2 logs` and check cron log files
- [ ] Test API endpoints (especially `/api/recheck/feed`)

---

## 9. Useful Commands

**Note:** In production, workers run **automatically** via PM2 or cron. These commands are for:

- **One-time testing** during setup
- **Manual troubleshooting** if needed
- **Development** environment

| Command                    | Description                                     | Production Usage                                 |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `npm run worker:enrich`    | Run enrich once (manual)                        | ❌ Not needed — runs automatically via PM2/cron  |
| `npm run worker:aggregate` | Run aggregate once (manual)                     | ❌ Not needed — runs automatically via PM2/cron  |
| `npm run worker:trust`     | Run trust worker (runs continuously)            | ✅ Use with PM2 for automatic continuous running |
| `npm run worker:recheck`   | Run recheck worker once (manual)                | ❌ Not needed — runs automatically via cron/PM2  |
| `npm run worker:snapshot`  | Run snapshot once (manual)                      | ❌ Not needed — runs automatically via cron      |
| `npm run worker:loop`      | Run enrich → aggregate in a loop (use with PM2) | ✅ Use with PM2 for automatic continuous running |

**Production Setup (Automatic):**

- **Enrich + Aggregate:** Use `npm run worker:loop` with PM2 (Section 3) — runs automatically 24/7
- **Trust Evaluation:** Use `npm run worker:trust` with PM2 (Section 6) — runs automatically 24/7
- **Recheck:** Use cron or PM2 cron (Section 7) — runs automatically hourly/daily
- **Snapshot:** Use cron (Section 5) — runs automatically once daily

**PM2 Commands:**

- `pm2 list` - List all running processes
- `pm2 logs` - View logs for all processes
- `pm2 logs <name>` - View logs for specific process
- `pm2 restart <name>` - Restart a process
- `pm2 stop <name>` - Stop a process
- `pm2 delete <name>` - Remove a process from PM2
- `pm2 save` - Save current process list
- `pm2 startup` - Generate startup script
- `pm2 monit` - Monitor processes (CPU, memory)

---

## 10. Complete PM2 Setup Example

**Recommended Production Setup:**

```bash
cd /path/to/bearbrick-backend

# 1. Enrich + Aggregate (loop)
WORKER_LOOP_INTERVAL_MS=60000 pm2 start npm --name "pricing-worker-loop" -- run worker:loop

# 2. Trust Evaluation Worker
pm2 start npm --name "pricing-worker-trust" -- run worker:trust

# 3. Recheck Worker (hourly via PM2 cron)
pm2 start npm --name "pricing-worker-recheck" --cron "0 * * * *" -- run worker:recheck

# 4. Save PM2 configuration
pm2 save

# 5. Generate startup script (if not done)
pm2 startup
```

**Snapshot Worker (via system cron):**

```bash
# Add to crontab
crontab -e

# Add this line (daily at 04:07 UTC = 11:07 PM EST)
7 4 * * * cd /path/to/bearbrick-backend && npm run worker:snapshot >> /var/log/pricing-snapshot.log 2>&1
```

---

## 11. Troubleshooting

### Trust Worker Not Processing Jobs

```bash
# Check if jobs exist
node -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); (async () => { const jobs = await p.trustWorkerJob.findMany({where: {status: 'PENDING'}}); console.log('Pending jobs:', jobs.length); await p.\$disconnect(); })()"

# Check cycle close events
node -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); (async () => { const events = await p.pricingCycleCloseEvent.count(); console.log('Cycle close events:', events); await p.\$disconnect(); })()"
```

### Recheck Worker Not Triggering

```bash
# Check recheck state
node -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); (async () => { const recheck = await p.brickPriceState.count({where: {needsRecheck: true}}); console.log('Bricks in recheck:', recheck); await p.\$disconnect(); })()"
```

### Workers Not Starting

1. Check Node.js version: `node --version` (should be 18+)
2. Check database connection: `npx prisma db pull` (should connect)
3. Check environment variables: `cat .env | grep DATABASE_URL`
4. Check PM2 logs: `pm2 logs`
5. Check cron logs: `tail -f /var/log/pricing-*.log`

---

## 12. Migration from Previous Version

If upgrading from a version without Trust/Recheck systems:

1. **Backup database** (recommended)
2. **Run migration:**
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
3. **Start new workers** (Sections 6 and 7)
4. **Existing workers continue** - no changes needed
5. **Monitor logs** for any issues

**No downtime required** - migration is additive and backward compatible.
