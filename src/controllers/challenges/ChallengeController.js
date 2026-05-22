'use strict';

// Thin HTTP layer over ChallengeAssignmentService. No business logic here —
// only auth extraction (handled by middleware), service call, and response
// shape conversion (BigInt → string, Date → ISO).

const AssignmentService = require('../../services/challenges/ChallengeAssignmentService');

function shape(row) {
  return {
    id: row.id?.toString?.() ?? row.id,
    template_id: row.template_id?.toString?.() ?? row.template_id,
    scope: row.scope,
    assignment_date: row.assignment_date ? row.assignment_date.toISOString().slice(0, 10) : null,
    assignment_week_key: row.assignment_week_key ? row.assignment_week_key.toISOString().slice(0, 10) : null,
    weekly_slot_type: row.weekly_slot_type || null,
    status: row.status,
    target_count: Number(row.target_count),
    progress_count: Number(row.progress_count),
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  };
}

async function daily(req, res) {
  try {
    const rows = await AssignmentService.getOrAssignDailies(req.user.id);
    return res.status(200).json({
      success: true,
      data: { assignments: rows.map(shape) },
    });
  } catch (err) {
    console.error('[ChallengeController.daily] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

async function weekly(req, res) {
  try {
    const rows = await AssignmentService.getOrAssignWeeklies(req.user.id);
    return res.status(200).json({
      success: true,
      data: { assignments: rows.map(shape) },
    });
  } catch (err) {
    console.error('[ChallengeController.weekly] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

async function assignIfNeeded(req, res) {
  try {
    const scope = req.body?.scope || 'both';
    const out = {};
    if (scope === 'daily' || scope === 'both') {
      const rows = await AssignmentService.getOrAssignDailies(req.user.id);
      out.daily = rows.map(shape);
    }
    if (scope === 'weekly' || scope === 'both') {
      const rows = await AssignmentService.getOrAssignWeeklies(req.user.id);
      out.weekly = rows.map(shape);
    }
    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    console.error('[ChallengeController.assignIfNeeded] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { daily, weekly, assignIfNeeded };
