'use strict';

const request = require('supertest');
const prisma = require('../../src/lib/prisma');
const { app, createFreshUser } = require('../helpers/dex');

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/sessions/today — auth', () => {
  test('returns 401 when no auth header', async () => {
    const res = await request(app).get('/api/sessions/today');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/sessions/today — JIT build + shape', () => {
  test('JIT-builds the day\'s morning + evening sets and returns expected shape', async () => {
    const { token, userId } = await createFreshUser('today1');
    // Default timezone is 'UTC' from the new column default
    const res = await request(app)
      .get('/api/sessions/today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data).toHaveProperty('local_day_key');
    expect(data).toHaveProperty('timezone', 'UTC');
    expect(data).toHaveProperty('current_window'); // 'MORNING' | 'EVENING' | null

    expect(data.morning).toBeDefined();
    expect(data.morning.target).toBe(7);
    expect(Array.isArray(data.morning.brick_ids)).toBe(true);
    expect(data.morning.brick_ids.length).toBeLessThanOrEqual(7);
    expect(typeof data.morning.partial_count).toBe('number');
    expect(typeof data.morning.completed).toBe('boolean');
    expect(typeof data.morning.expired).toBe('boolean');

    expect(data.evening).toBeDefined();
    expect(data.evening.target).toBe(11);
    expect(Array.isArray(data.evening.brick_ids)).toBe(true);
    expect(data.evening.brick_ids.length).toBeLessThanOrEqual(11);

    expect(data.streaks).toBeDefined();
    expect(data.streaks.morning).toBe(0);
    expect(data.streaks.evening).toBe(0);
  });

  test('morning and evening sets do not overlap (no brick appears in both)', async () => {
    const { token } = await createFreshUser('today2');
    const res = await request(app)
      .get('/api/sessions/today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const morning = res.body.data.morning.brick_ids;
    const evening = res.body.data.evening.brick_ids;
    const overlap = morning.filter((id) => evening.includes(id));
    expect(overlap).toEqual([]);
  });

  test('two consecutive calls for the same user return the same set (idempotent)', async () => {
    const { token } = await createFreshUser('today3');
    const r1 = await request(app)
      .get('/api/sessions/today')
      .set('Authorization', `Bearer ${token}`);
    const r2 = await request(app)
      .get('/api/sessions/today')
      .set('Authorization', `Bearer ${token}`);
    expect(r1.body.data.morning.brick_ids).toEqual(r2.body.data.morning.brick_ids);
    expect(r1.body.data.evening.brick_ids).toEqual(r2.body.data.evening.brick_ids);
  });
});
