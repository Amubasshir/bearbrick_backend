'use strict';

const request = require('supertest');
const app = require('../../src/app');
const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');

const createdUserIds = [];

async function insertInbox({ userId, title, isRead = false }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO inbox_entries
       (user_id, entry_type, title, body, reference_type, reference_id, metadata, is_read)
     VALUES ($1, 'leaderboard_reward'::"InboxEntryType", $2, 'body text',
             'leaderboard_period', 'weekly_collector_xp:2099-W01-inboxtest',
             '{"placement_tier": "top_1"}'::jsonb, $3)
     RETURNING id`,
    BigInt(userId), title, !!isRead
  );
  return String(rows[0].id);
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(`DELETE FROM inbox_entries WHERE user_id = $1`, BigInt(id));
    // User rows kept (see leaderboards.test.js note).
  }
  await prisma.$disconnect();
});

describe('GET /api/progress/inbox', () => {
  test('401 without auth', async () => {
    const res = await request(app).get('/api/progress/inbox');
    expect(res.status).toBe(401);
  });

  test('200 returns user entries sorted DESC by created_at', async () => {
    const u = await createFreshUser('ix-list');
    createdUserIds.push(u.userId);
    const oldId = await insertInbox({ userId: u.userId, title: 'older' });
    // Force the second row to have a strictly later created_at.
    await new Promise((r) => setTimeout(r, 20));
    const newId = await insertInbox({ userId: u.userId, title: 'newer' });

    const res = await request(app)
      .get('/api/progress/inbox')
      .set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.data.entries.map((e) => e.id);
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId));
    expect(res.body.data.entries[0].entry_type).toBe('leaderboard_reward');
    expect(res.body.data.entries[0].metadata).toEqual({ placement_tier: 'top_1' });
  });

  test('is_read=false filter excludes read entries', async () => {
    const u = await createFreshUser('ix-filter');
    createdUserIds.push(u.userId);
    await insertInbox({ userId: u.userId, title: 'unread one', isRead: false });
    await insertInbox({ userId: u.userId, title: 'read one',   isRead: true  });

    const res = await request(app)
      .get('/api/progress/inbox?is_read=false')
      .set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    const titles = res.body.data.entries.map((e) => e.title);
    expect(titles).toContain('unread one');
    expect(titles).not.toContain('read one');
  });
});

describe('PATCH /api/progress/inbox/:id/read', () => {
  test('marks own entry as read; subsequent fetch shows is_read=true', async () => {
    const u = await createFreshUser('ix-markread');
    createdUserIds.push(u.userId);
    const id = await insertInbox({ userId: u.userId, title: 'to read' });

    const r1 = await request(app)
      .patch(`/api/progress/inbox/${id}/read`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(r1.status).toBe(204);

    const r2 = await request(app)
      .get('/api/progress/inbox')
      .set('Authorization', `Bearer ${u.token}`);
    const entry = r2.body.data.entries.find((e) => e.id === id);
    expect(entry.is_read).toBe(true);
  });

  test('404 when entry belongs to another user', async () => {
    const a = await createFreshUser('ix-own-a');
    const b = await createFreshUser('ix-own-b');
    createdUserIds.push(a.userId, b.userId);
    const id = await insertInbox({ userId: a.userId, title: 'owned by A' });

    const res = await request(app)
      .patch(`/api/progress/inbox/${id}/read`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(404);
  });

  test('already-read entry is treated as idempotent 204', async () => {
    const u = await createFreshUser('ix-idem');
    createdUserIds.push(u.userId);
    const id = await insertInbox({ userId: u.userId, title: 'pre-read', isRead: true });

    const res = await request(app)
      .patch(`/api/progress/inbox/${id}/read`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(204);
  });
});
