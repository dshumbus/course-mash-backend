const express = require('express');
const { getLeaderboard, getMatchCounts, getStats } = require('../services/eloService');

const router = express.Router();

/**
 * Everything the frontend needs to boot: replaces the old
 * window.storage.get(STORAGE_KEY) call. Elo values are included
 * (needed client-side to pick low-match-count matchups fairly),
 * but note the UI itself never displays raw ratings — only rank.
 */
router.get('/state', async (req, res) => {
  try {
    const [leaderboard, matches, stats] = await Promise.all([
      getLeaderboard(),
      getMatchCounts(),
      getStats(),
    ]);
    const rows = {};
    for (const { id, elo } of leaderboard) {
      rows[id] = [elo, matches[id] || 0];
    }
    // Courses that exist in the catalog but haven't been seeded/voted
    // on yet simply won't have a row here; the frontend already
    // treats a missing row as "not yet played" (see defaultRow()).
    res.json({ rows, totalVotes: stats.totalVotes, votesToday: stats.votesToday });
  } catch (err) {
    console.error('[state] failed:', err);
    res.status(500).json({ error: 'failed to load state' });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const rows = await getLeaderboard();
    res.json({ rows });
  } catch (err) {
    console.error('[leaderboard] failed:', err);
    res.status(500).json({ error: 'failed to load leaderboard' });
  }
});

module.exports = router;
