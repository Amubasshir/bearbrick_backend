# DevOps Update Guide — v1.0 New Features

**Date:** February 16, 2026  
**Version:** 1.0 (Complete Implementation)

This guide outlines what DevOps needs to update for the new Trust & Recheck systems.

---

## 🚨 CRITICAL: Required Updates

### 1. Database Migration (MUST RUN FIRST)

**⚠️ DO THIS FIRST before starting any workers:**

```bash
cd /path/to/bearbrick-backend
npx prisma migrate deploy
npx prisma generate
```

**What it does:**

- Creates 5 new tables (trust_score_events, user_trust_state, pricing_cycle_close_events, trust_worker_jobs, brick_freeze_window_events)
- Adds recheck fields to existing tables
- **Safe:** Additive migration, no data loss

**Verification:**

```bash
# Check migration applied
npx prisma migrate status

# Verify new tables exist
psql $DATABASE_URL -c "\dt" | grep -E "trust|recheck|cycle_close|freeze_window"
```

---

## 2. New Workers to Deploy

### 2.1 Trust Evaluation Worker (REQUIRED)

**Purpose:** Scores user votes and updates trust tiers based on cycle outcomes.

**Deployment:**

```bash
# Option A: PM2 (Recommended)
pm2 start npm --name "pricing-worker-trust" -- run worker:trust
pm2 save

# Option B: Systemd service (alternative)
# Create service file at /etc/systemd/system/pricing-worker-trust.service
```

**Configuration:**

- Runs continuously (infinite loop)
- Processes jobs from `trust_worker_jobs` queue
- Safe to run multiple instances (atomic job claiming)
- No special environment variables required

**Monitoring:**

```bash
pm2 logs pricing-worker-trust
pm2 status pricing-worker-trust
```

---

### 2.2 Recheck Worker (REQUIRED)

**Purpose:** Evaluates recheck triggers and manages state machine.

**Deployment Options:**

**Option A: Cron (Recommended)**

```bash
# Edit crontab
crontab -e

# Add hourly job (runs at minute 0 of every hour)
0 * * * * cd /path/to/bearbrick-backend && npm run worker:recheck >> /var/log/pricing-recheck.log 2>&1
```

**Option B: PM2 Cron**

```bash
pm2 start npm --name "pricing-worker-recheck" --cron "0 * * * *" -- run worker:recheck
pm2 save
```

**Option C: PM2 Continuous**

```bash
RECHECK_WORKER_INTERVAL_MIN=60 pm2 start npm --name "pricing-worker-recheck" -- run worker:recheck
pm2 save
```

**Configuration:**

- `RECHECK_WORKER_INTERVAL_MIN` (optional, default: 60) - Run interval in minutes
- Uses PostgreSQL advisory locks (safe for concurrent execution)

**Monitoring:**

```bash
# If using PM2
pm2 logs pricing-worker-recheck

# If using cron
tail -f /var/log/pricing-recheck.log
```

---

## 3. Existing Workers (NO CHANGES NEEDED)

✅ **Enrich Worker** - No changes, continues to work  
✅ **Aggregate Worker** - No changes, now automatically logs cycle close and freeze window events  
✅ **Snapshot Worker** - No changes, continues to work

**Note:** Existing workers will automatically start logging new events. No configuration changes needed.

---

## 4. Environment Variables

**New Optional Variables:**

```bash
# Recheck Worker interval (minutes)
RECHECK_WORKER_INTERVAL_MIN=60

# Trust Worker instance ID (auto-generated if not set)
WORKER_INSTANCE_ID=worker-prod-001

# Existing variables still work
WORKER_LOOP_INTERVAL_MS=60000
DATABASE_URL=postgresql://...
JWT_SECRET=...
```

**Update `.env` file** (optional, defaults work fine):

```bash
# Add to .env (optional)
RECHECK_WORKER_INTERVAL_MIN=60
```

---

## 5. Complete Deployment Checklist

### Pre-Deployment

- [ ] **Backup database** (recommended)
- [ ] **Run migration:** `npx prisma migrate deploy && npx prisma generate`
- [ ] Verify migration success
- [ ] Check `.env` file has all required variables

### Worker Deployment

- [ ] **Trust Worker:** Start with PM2 (`pm2 start npm --name "pricing-worker-trust" -- run worker:trust`)
- [ ] **Recheck Worker:** Set up cron or PM2 cron (hourly recommended)
- [ ] **Existing Workers:** Verify still running (no changes needed)
- [ ] **Snapshot Worker:** Verify cron still configured

### Post-Deployment Verification

- [ ] Check PM2 status: `pm2 list` (should show all workers)
- [ ] Check PM2 logs: `pm2 logs` (no errors)
- [ ] Check cron jobs: `crontab -l` (should show recheck and snapshot)
- [ ] Test API: `curl http://localhost:3000/api/recheck/feed` (with auth token)
- [ ] Monitor for 24 hours to ensure stability

---

## 6. PM2 Ecosystem File (Optional)

Create `ecosystem.config.js` for easier management:

```javascript
module.exports = {
  apps: [
    {
      name: "pricing-worker-loop",
      script: "npm",
      args: "run worker:loop",
      env: {
        WORKER_LOOP_INTERVAL_MS: 60000,
      },
      autorestart: true,
      max_memory_restart: "500M",
    },
    {
      name: "pricing-worker-trust",
      script: "npm",
      args: "run worker:trust",
      env: {
        WORKER_INSTANCE_ID: "worker-prod-001",
      },
      autorestart: true,
      max_memory_restart: "500M",
    },
    {
      name: "pricing-worker-recheck",
      script: "npm",
      args: "run worker:recheck",
      cron_restart: "0 * * * *", // Hourly
      autorestart: false,
      env: {
        RECHECK_WORKER_INTERVAL_MIN: 60,
      },
    },
  ],
};
```

**Usage:**

```bash
pm2 start ecosystem.config.js
pm2 save
```

---

## 7. Monitoring & Alerts

### Key Metrics to Monitor

1. **Trust Worker:**

   - Jobs processed per hour
   - Failed jobs count
   - Trust states updated

2. **Recheck Worker:**

   - Bricks in recheck state
   - Recheck activations per day
   - Worker execution time

3. **Database:**
   - Cycle close events count
   - Trust score events count
   - Freeze window events count

### Log Locations

- **PM2 logs:** `~/.pm2/logs/`
- **Cron logs:** `/var/log/pricing-recheck.log`, `/var/log/pricing-snapshot.log`
- **Application logs:** Check PM2 logs or application log files

### Health Checks

```bash
# Check all workers running
pm2 list | grep pricing-worker

# Check database tables exist
psql $DATABASE_URL -c "SELECT COUNT(*) FROM trust_worker_jobs;"

# Check recheck state
psql $DATABASE_URL -c "SELECT COUNT(*) FROM brick_price_state WHERE needs_recheck = true;"
```

---

## 8. Rollback Plan (If Needed)

If issues occur:

1. **Stop new workers:**

   ```bash
   pm2 stop pricing-worker-trust
   pm2 stop pricing-worker-recheck
   ```

2. **Existing workers continue** - no impact on core pricing

3. **Database migration is additive** - no rollback needed (tables can remain)

4. **Restart when fixed:**
   ```bash
   pm2 restart pricing-worker-trust
   pm2 restart pricing-worker-recheck
   ```

---

## 9. Quick Reference

### Start All Workers

```bash
# Enrich + Aggregate (loop)
pm2 start npm --name "pricing-worker-loop" -- run worker:loop

# Trust Evaluation
pm2 start npm --name "pricing-worker-trust" -- run worker:trust

# Recheck (hourly)
pm2 start npm --name "pricing-worker-recheck" --cron "0 * * * *" -- run worker:recheck

# Save configuration
pm2 save
```

### Stop All Workers

```bash
pm2 stop pricing-worker-loop
pm2 stop pricing-worker-trust
pm2 stop pricing-worker-recheck
```

### Restart All Workers

```bash
pm2 restart all
```

### View All Logs

```bash
pm2 logs
```

---

## 10. Support

For issues:

1. Check logs: `pm2 logs` and cron logs
2. Verify database migration: `npx prisma migrate status`
3. Check worker status: `pm2 list`
4. Review [DEVOPS_WORKER_SETUP.md](./DEVOPS_WORKER_SETUP.md) for detailed setup

---

**Status:** Ready for Production Deployment ✅
