'use strict';

// Thin write/read helper over inbox_entries. M3d writes only
// 'leaderboard_reward' entries (called from RewardIssuanceService.issue).
// Other entry_type values are reserved for forward compatibility; the M3a/M3b/
// M3c workers are NOT modified in M3d to write them.
//
// `create` accepts a tx so the caller can include it in the same transaction
// as a reward issuance — keeping reward + inbox visibility atomic. `markRead`
// and `listForUser` use the top-level prisma client (they're read API helpers,
// not part of any worker transaction).
//
// No idempotency guard here: a duplicate `create` call would write a duplicate
// inbox row. The caller (RewardIssuanceService) prevents this by gating on the
// reward_events idempotency key BEFORE calling `create`.

const prisma = require('../../lib/prisma');

/**
 * Insert one inbox entry inside the caller's transaction.
 *
 * @param {*} tx                       Prisma transaction client
 * @param {object} opts
 * @param {bigint|number|string} opts.userId
 * @param {string} opts.entryType      Must be a value from the InboxEntryType enum
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.referenceType]
 * @param {string} [opts.referenceId]
 * @param {object} [opts.metadata]     Defaults to {}
 * @returns {Promise<{id: string}>}    Inserted row id
 */
async function create(tx, {
  userId, entryType, title, body = null,
  referenceType = null, referenceId = null, metadata = {},
}) {
  if (!userId) throw new Error('InboxService.create: userId is required');
  if (!entryType) throw new Error('InboxService.create: entryType is required');
  if (!title) throw new Error('InboxService.create: title is required');

  const userIdBig = BigInt(userId);
  const metadataJson = JSON.stringify(metadata ?? {});
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO inbox_entries
       (user_id, entry_type, title, body, reference_type, reference_id, metadata)
     VALUES ($1, $2::"InboxEntryType", $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    userIdBig, entryType, title, body, referenceType, referenceId, metadataJson
  );
  return { id: rows[0].id };
}

/**
 * Mark one entry as read. Returns true if the row was updated, false if not
 * found / not owned by `userId`. Ownership is enforced in the WHERE clause.
 */
async function markRead(prismaClient, { userId, entryId }) {
  const userIdBig = BigInt(userId);
  const entryIdBig = BigInt(entryId);
  const result = await prismaClient.$executeRawUnsafe(
    `UPDATE inbox_entries SET is_read = TRUE
      WHERE id = $1 AND user_id = $2 AND is_read = FALSE`,
    entryIdBig, userIdBig
  );
  return Number(result) > 0;
}

/**
 * List inbox entries for a user. Cursor-paginated by created_at DESC.
 *
 * @param {*} prismaClient
 * @param {object} opts
 * @param {bigint|number|string} opts.userId
 * @param {boolean} [opts.isReadFilter]   If set, filter by is_read = value
 * @param {string|Date} [opts.cursor]     ISO timestamp; returns rows older than this
 * @param {number} [opts.limit]           Default 25, capped at 50
 * @returns {Promise<{entries: object[], next_cursor: string|null}>}
 */
async function listForUser(prismaClient, {
  userId, isReadFilter, cursor, limit = 25,
}) {
  const userIdBig = BigInt(userId);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 50);

  const params = [userIdBig];
  let where = `user_id = $1`;
  if (typeof isReadFilter === 'boolean') {
    params.push(isReadFilter);
    where += ` AND is_read = $${params.length}`;
  }
  if (cursor) {
    const cursorTs = cursor instanceof Date ? cursor : new Date(cursor);
    params.push(cursorTs);
    where += ` AND created_at < $${params.length}`;
  }

  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT id, user_id, entry_type, title, body,
            reference_type, reference_id, metadata, is_read, created_at
       FROM inbox_entries
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit + 1}`,
    ...params
  );

  let nextCursor = null;
  let entries = rows;
  if (rows.length > safeLimit) {
    entries = rows.slice(0, safeLimit);
    nextCursor = entries[entries.length - 1].created_at.toISOString();
  }
  return { entries, next_cursor: nextCursor };
}

module.exports = {
  create,
  markRead,
  listForUser,
};
