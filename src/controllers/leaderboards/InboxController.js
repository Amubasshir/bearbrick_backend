'use strict';

// GET    /api/progress/inbox            — list inbox entries (cursor paginated)
// PATCH  /api/progress/inbox/:id/read   — mark one entry as read

const prisma = require('../../lib/prisma');
const InboxService =
  require('../../services/leaderboards/InboxService');

function shape(row) {
  return {
    id: String(row.id),
    entry_type: row.entry_type,
    title: row.title,
    body: row.body || null,
    reference_type: row.reference_type || null,
    reference_id: row.reference_id || null,
    metadata: row.metadata || {},
    is_read: !!row.is_read,
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  };
}

async function list(req, res) {
  try {
    const userId = BigInt(req.user.id);
    const { is_read, cursor, limit } = req.query;
    const opts = { userId };
    if (typeof is_read === 'string') {
      if (is_read === 'true')  opts.isReadFilter = true;
      else if (is_read === 'false') opts.isReadFilter = false;
      // Any other value → ignore filter (forward-compatible).
    }
    if (cursor) opts.cursor = cursor;
    if (limit)  opts.limit = Number(limit);

    const { entries, next_cursor } = await InboxService.listForUser(prisma, opts);
    return res.status(200).json({
      success: true,
      data: { entries: entries.map(shape), next_cursor },
    });
  } catch (err) {
    console.error('[InboxController.list] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

async function markRead(req, res) {
  try {
    const userId = BigInt(req.user.id);
    const entryId = req.params.id;
    // Validate id is a positive integer; otherwise 404 (avoid leaking format).
    if (!/^\d+$/.test(String(entryId))) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    const ok = await InboxService.markRead(prisma, { userId, entryId });
    if (!ok) {
      // Either not found, not owned, or already read → 404 for security parity
      // (don't leak which inbox entries exist for other users).
      // But: if the row exists+owned+already-read, that's idempotent success —
      // distinguish by checking ownership.
      const owned = await prisma.$queryRawUnsafe(
        `SELECT is_read FROM inbox_entries WHERE id = $1 AND user_id = $2`,
        BigInt(entryId), userId
      );
      if (owned.length === 0) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      // Already read — treat as idempotent success.
      return res.status(204).send();
    }
    return res.status(204).send();
  } catch (err) {
    console.error('[InboxController.markRead] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { list, markRead };
