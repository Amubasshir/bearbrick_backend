'use strict';

const request = require('supertest');
const app = require('../../src/app');
const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');

async function cleanupUser(id) {
  if (!id) return;
  const big = BigInt(id);
  await prisma.$queryRawUnsafe(`DELETE FROM challenge_completion_events WHERE user_id = $1`, big);
  await prisma.$queryRawUnsafe(`DELETE FROM user_challenge_assignments WHERE user_id = $1`, big);
  await prisma.$queryRawUnsafe(`DELETE FROM challenge_assignment_log WHERE user_id = $1`, big);
}

const userIds = [];
afterAll(async () => {
  for (const id of userIds) await cleanupUser(id);
  await prisma.$disconnect();
});

describe('API — /api/challenges/*', () => {
  describe('GET /api/challenges/daily', () => {
    test('401 without auth token', async () => {
      const res = await request(app).get('/api/challenges/daily');
      expect(res.status).toBe(401);
    });

    test('200 + 5 assignments on first call; second call returns same set', async () => {
      const { token, userId } = await createFreshUser('m3c-daily');
      userIds.push(userId);

      const r1 = await request(app)
        .get('/api/challenges/daily')
        .set('Authorization', `Bearer ${token}`);
      expect(r1.status).toBe(200);
      expect(r1.body.success).toBe(true);
      expect(r1.body.data.assignments).toHaveLength(5);
      for (const a of r1.body.data.assignments) {
        expect(a.scope).toBe('daily');
        expect(a.status).toBe('assigned');
        expect(a.progress_count).toBe(0);
        expect(a.expires_at).toMatch(/T\d\d:\d\d:\d\d/);
      }

      const r2 = await request(app)
        .get('/api/challenges/daily')
        .set('Authorization', `Bearer ${token}`);
      expect(r2.status).toBe(200);
      expect(r2.body.data.assignments.map((a) => a.id).sort())
        .toEqual(r1.body.data.assignments.map((a) => a.id).sort());
    });
  });

  describe('GET /api/challenges/weekly', () => {
    test('401 without auth token', async () => {
      const res = await request(app).get('/api/challenges/weekly');
      expect(res.status).toBe(401);
    });

    test('200 + 3 weekly assignments with canonical slot types', async () => {
      const { token, userId } = await createFreshUser('m3c-weekly');
      userIds.push(userId);

      const res = await request(app)
        .get('/api/challenges/weekly')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const a = res.body.data.assignments;
      expect(a).toHaveLength(3);
      const slots = a.map((x) => x.weekly_slot_type).sort();
      expect(slots).toEqual(['exploration', 'maintenance', 'wildcard'].sort());
      for (const r of a) {
        expect(r.scope).toBe('weekly');
        expect(r.assignment_date).toBeNull();
        expect(r.assignment_week_key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('POST /api/challenges/assign-if-needed', () => {
    test('scope=both returns both daily and weekly arrays; idempotent', async () => {
      const { token, userId } = await createFreshUser('m3c-assignif');
      userIds.push(userId);

      const r1 = await request(app)
        .post('/api/challenges/assign-if-needed')
        .set('Authorization', `Bearer ${token}`)
        .send({ scope: 'both' });
      expect(r1.status).toBe(200);
      expect(r1.body.data.daily).toHaveLength(5);
      expect(r1.body.data.weekly).toHaveLength(3);

      const r2 = await request(app)
        .post('/api/challenges/assign-if-needed')
        .set('Authorization', `Bearer ${token}`)
        .send({ scope: 'both' });
      expect(r2.body.data.daily.map((a) => a.id).sort())
        .toEqual(r1.body.data.daily.map((a) => a.id).sort());
      expect(r2.body.data.weekly.map((a) => a.id).sort())
        .toEqual(r1.body.data.weekly.map((a) => a.id).sort());
    });

    test('scope=daily returns only daily', async () => {
      const { token, userId } = await createFreshUser('m3c-assignif-d');
      userIds.push(userId);
      const res = await request(app)
        .post('/api/challenges/assign-if-needed')
        .set('Authorization', `Bearer ${token}`)
        .send({ scope: 'daily' });
      expect(res.status).toBe(200);
      expect(res.body.data.daily).toHaveLength(5);
      expect(res.body.data.weekly).toBeUndefined();
    });
  });
});
