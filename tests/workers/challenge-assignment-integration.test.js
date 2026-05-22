'use strict';

const prisma = require('../../src/lib/prisma');
const {
  getOrAssignDailies,
  getOrAssignWeeklies,
} = require('../../src/services/challenges/ChallengeAssignmentService');

let testUserId;

async function createTestUser(timezone = 'UTC') {
  const tag = `m3c_assign_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO "User" (name, email, password, email_verified_at, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', NOW(), $3, NOW(), NOW())
     RETURNING id`,
    tag, `${tag}@m3c.test`, timezone
  );
  return BigInt(r[0].id);
}

async function cleanupUser(id) {
  if (!id) return;
  await prisma.$queryRawUnsafe(
    `DELETE FROM user_challenge_assignments WHERE user_id = $1`, id
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM challenge_assignment_log WHERE user_id = $1`, id
  );
  await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
}

afterAll(async () => {
  if (testUserId) await cleanupUser(testUserId);
  await prisma.$disconnect();
});

describe('ChallengeAssignmentService — integration', () => {
  describe('getOrAssignDailies', () => {
    test('first call assigns exactly 5 daily challenges; second call returns same rows', async () => {
      testUserId = await createTestUser('UTC');
      const nowUtc = new Date('2099-09-15T10:00:00Z'); // far-future, fresh pool date

      const first = await getOrAssignDailies(testUserId, nowUtc, prisma);
      expect(first).toHaveLength(5);
      // All scope=daily, assignment_date matches user's local day
      for (const a of first) {
        expect(a.scope).toBe('daily');
        expect(a.user_id).toEqual(testUserId);
        expect(a.assignment_date).toEqual(new Date('2099-09-15T00:00:00.000Z'));
        expect(a.status).toBe('assigned');
        expect(Number(a.progress_count)).toBe(0);
      }

      const second = await getOrAssignDailies(testUserId, nowUtc, prisma);
      expect(second).toHaveLength(5);
      expect(second.map((a) => a.id.toString()).sort())
        .toEqual(first.map((a) => a.id.toString()).sort());

      await cleanupUser(testUserId);
      testUserId = null;
    });

    test('contribute family is filtered out while feature flag is FALSE — fallback fills 5th slot', async () => {
      // The seed has 2 contribute templates and the daily pool always reserves
      // a contribute slot. With the flag off, the validator rejects them and
      // the fallback path must backfill. Final assignment must still be 5.
      testUserId = await createTestUser('UTC');
      const nowUtc = new Date('2099-09-16T10:00:00Z');

      const assignments = await getOrAssignDailies(testUserId, nowUtc, prisma);
      expect(assignments).toHaveLength(5);

      // None of the assigned templates require contribution access
      const templateIds = assignments.map((a) => BigInt(a.template_id));
      const templates = await prisma.$queryRawUnsafe(
        `SELECT id, requires_contribution_access, challenge_family
           FROM challenge_templates WHERE id = ANY($1::bigint[])`,
        templateIds.map((b) => Number(b))
      );
      for (const t of templates) {
        expect(t.requires_contribution_access).toBe(false);
        expect(t.challenge_family).not.toBe('contribute');
      }

      // And the assignment_log should have at least one row recording the
      // contribute filter decision for this user.
      const log = await prisma.$queryRawUnsafe(
        `SELECT decision FROM challenge_assignment_log
          WHERE user_id = $1 AND assignment_date = $2::date
          ORDER BY id ASC`,
        testUserId, '2099-09-16'
      );
      const reasons = log.map((r) => r.decision);
      expect(reasons.some((r) => r.startsWith('filtered:contribution_system_disabled'))).toBe(true);

      await cleanupUser(testUserId);
      testUserId = null;
    });

    test('expires_at is the next local 5AM (UTC user → next day 05:00 UTC)', async () => {
      testUserId = await createTestUser('UTC');
      const nowUtc = new Date('2099-09-17T10:00:00Z');

      const [first] = await getOrAssignDailies(testUserId, nowUtc, prisma);
      // local_day_key 2099-09-17 → expires at 2099-09-18 05:00 UTC
      expect(first.expires_at.toISOString()).toBe('2099-09-18T05:00:00.000Z');

      await cleanupUser(testUserId);
      testUserId = null;
    });
  });

  describe('getOrAssignWeeklies', () => {
    test('assigns exactly 3 weekly challenges with the canonical slot types', async () => {
      testUserId = await createTestUser('UTC');
      // 2099-09-15 is far-future; week starts Monday. Picking a Wednesday so
      // mondayOf yields a different DATE from the input.
      const nowUtc = new Date('2099-09-16T10:00:00Z'); // Wednesday in real-cal terms

      const weeklies = await getOrAssignWeeklies(testUserId, nowUtc, prisma);
      expect(weeklies).toHaveLength(3);

      const slots = weeklies.map((a) => a.weekly_slot_type).sort();
      expect(slots).toEqual(['exploration', 'maintenance', 'wildcard'].sort());

      for (const a of weeklies) {
        expect(a.scope).toBe('weekly');
        expect(a.assignment_date).toBeNull();
        expect(a.assignment_week_key).not.toBeNull();
      }

      // Idempotent
      const again = await getOrAssignWeeklies(testUserId, nowUtc, prisma);
      expect(again.map((a) => a.id.toString()).sort())
        .toEqual(weeklies.map((a) => a.id.toString()).sort());

      await cleanupUser(testUserId);
      testUserId = null;
    });

    test('expires_at is next Monday 5AM in user timezone', async () => {
      testUserId = await createTestUser('UTC');
      const nowUtc = new Date('2099-09-15T10:00:00Z');
      const [first] = await getOrAssignWeeklies(testUserId, nowUtc, prisma);
      // assignment_week_key is Monday of week containing 2099-09-15.
      // Wherever that is, expires_at should be exactly 7 days after that Monday at 05:00 UTC.
      const wk = first.assignment_week_key;
      const expectedExpiry = new Date(wk.getTime() + 7 * 24 * 3600 * 1000 + 5 * 3600 * 1000);
      expect(first.expires_at.toISOString()).toBe(expectedExpiry.toISOString());

      await cleanupUser(testUserId);
      testUserId = null;
    });
  });
});
