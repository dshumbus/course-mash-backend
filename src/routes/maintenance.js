const express = require('express');
const { runMaintenance, getStorageStatus } = require('../services/maintenanceService');

const router = express.Router();

function requireAdmin(req, res, next) {
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// GET current storage usage vs. the 250MB budget, and which tier
// (i.e. vote-log cap) is currently in effect.
router.get('/admin/storage', requireAdmin, async (req, res) => {
  try {
    res.json(await getStorageStatus());
  } catch (err) {
    console.error('[admin/storage] failed:', err);
    res.status(500).json({ error: 'failed to read storage status' });
  }
});

// POST to force an immediate maintenance pass — useful right after
// deploy, or wired up to an external cron (e.g. Vercel Cron, GitHub
// Actions schedule) as the guaranteed-to-run backstop to the
// in-request sampled checks in maybeRunMaintenance().
router.post('/admin/maintenance/run', requireAdmin, async (req, res) => {
  try {
    res.json(await runMaintenance());
  } catch (err) {
    console.error('[admin/maintenance/run] failed:', err);
    res.status(500).json({ error: 'maintenance run failed' });
  }
});

module.exports = router;
