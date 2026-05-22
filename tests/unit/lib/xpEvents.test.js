'use strict';

// Pure unit tests for the SQL shape produced by insertXpEvent. We don't hit
// a real DB here — we capture the SQL + parameters via a fake `tx`.

const { buildInsertXpEventCalls } = require('../../../src/lib/xpEvents');

describe('lib/xpEvents — insertXpEvent helper', () => {
  test('builds claim → insert → backfill in that order', () => {
    const calls = buildInsertXpEventCalls({
      userId: 42n,
      xpAmount: 100,
      reason: 'STREAK',
      eventType: 'challenge_completion',
      sourceSystem: 'm3c',
      localDayKey: '2026-05-18',
      idempotencyKey: 'challenge_xp:777',
      voteEventId: null,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toMatch(/INSERT INTO xp_idempotency_keys/);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(calls[0].params).toEqual(['challenge_xp:777', 42n]);

    expect(calls[1].sql).toMatch(/INSERT INTO xp_events/);
    expect(calls[1].sql).toMatch(/"createdAt"/);
    expect(calls[1].params).toEqual([
      42n,            // user_id
      null,           // vote_event_id
      100,            // xp_amount
      'STREAK',       // reason
      'challenge_completion', // event_type
      'm3c',          // source_system (now parametric)
      '2026-05-18',   // local_day_key
      'challenge_xp:777',
    ]);

    expect(calls[2].sql).toMatch(/UPDATE xp_idempotency_keys SET xp_event_id/);
    // params for backfill use placeholders ($1 key, $2 id) — id is inserted at call time
    expect(calls[2].params[0]).toBe('challenge_xp:777');
  });

  test('vote-derived event passes voteEventId through', () => {
    const calls = buildInsertXpEventCalls({
      userId: 5n,
      xpAmount: 50,
      reason: 'STREAK',
      eventType: 'session_completion',
      sourceSystem: 'm3b',
      localDayKey: '2026-05-18',
      idempotencyKey: 'session_completion:5:abc',
      voteEventId: 12345n,
    });
    expect(calls[1].params[1]).toBe(12345n);
    expect(calls[1].params[5]).toBe('m3b');
  });

  test('throws if any required field missing', () => {
    expect(() =>
      buildInsertXpEventCalls({
        userId: 1n,
        xpAmount: 10,
        reason: 'STREAK',
        // eventType missing
        sourceSystem: 'm3c',
        localDayKey: '2026-05-18',
        idempotencyKey: 'k',
      })
    ).toThrow(/eventType/);
  });
});

describe('lib/xpEvents — insertXpEvent integration with fake tx', () => {
  const { insertXpEvent } = require('../../../src/lib/xpEvents');

  function makeFakeTx({ claimWins = true, insertedId = 999n } = {}) {
    const queries = [];
    return {
      queries,
      $queryRawUnsafe: jest.fn(async (sql, ...params) => {
        queries.push({ sql, params });
        if (sql.includes('INSERT INTO xp_idempotency_keys')) {
          return claimWins ? [{ key: params[0] }] : [];
        }
        if (sql.includes('INSERT INTO xp_events')) {
          return [{ id: insertedId }];
        }
        if (sql.includes('UPDATE xp_idempotency_keys SET xp_event_id')) {
          return [];
        }
        return [];
      }),
    };
  }

  test('returns inserted id on first claim', async () => {
    const tx = makeFakeTx({ claimWins: true, insertedId: 777n });
    const id = await insertXpEvent(tx, {
      userId: 1n,
      xpAmount: 10,
      reason: 'STREAK',
      eventType: 'challenge_completion',
      sourceSystem: 'm3c',
      localDayKey: '2026-05-18',
      idempotencyKey: 'x',
    });
    expect(id).toBe(777n);
    expect(tx.queries).toHaveLength(3);
  });

  test('returns null and skips insert when idempotency key already claimed', async () => {
    const tx = makeFakeTx({ claimWins: false });
    const id = await insertXpEvent(tx, {
      userId: 1n,
      xpAmount: 10,
      reason: 'STREAK',
      eventType: 'challenge_completion',
      sourceSystem: 'm3c',
      localDayKey: '2026-05-18',
      idempotencyKey: 'x',
    });
    expect(id).toBeNull();
    expect(tx.queries).toHaveLength(1); // only the claim attempt
  });
});
