'use strict';

// Thin HTTP layer over LeaderboardReadService. Reads use optionalAuth — guests
// see the board but get user_row=null. Auth'd viewers see their own row in
// every response regardless of tab.

const LeaderboardReadService =
  require('../../services/leaderboards/LeaderboardReadService');

function shapeRow(r) {
  if (!r) return null;
  return {
    rank: r.rank ?? null,
    user_id: r.user_id != null ? String(r.user_id) : null,
    score: r.score != null ? Number(r.score) : 0,
    tie_break_timestamp: r.tie_break_timestamp instanceof Date
      ? r.tie_break_timestamp.toISOString()
      : r.tie_break_timestamp || null,
    eligible: r.eligible != null ? !!r.eligible : true,
  };
}

async function getOne(req, res) {
  try {
    const view = await LeaderboardReadService.getView({
      leaderboardKey: req.params.key,
      periodKey: req.query.period_key || undefined,
      tab: req.query.tab,
      viewerUserId: req.user ? req.user.id : null,
    });
    return res.status(200).json({
      success: true,
      data: {
        leaderboard_key: view.leaderboard_key,
        period_key: view.period_key,
        scope: view.scope,
        tab: view.tab,
        rows: view.rows.map(shapeRow),
        user_row: shapeRow(view.user_row),
        reset_at: view.reset_at instanceof Date
          ? view.reset_at.toISOString()
          : view.reset_at,
        reward_tier_preview: view.reward_tier_preview,
        anti_sniping_active: view.anti_sniping_active,
        source: view.source,
      },
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[LeaderboardController.getOne] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { getOne };
