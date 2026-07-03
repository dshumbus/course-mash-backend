const express = require('express');
const { castVote } = require('../services/eloService');
const { maybeRunMaintenance } = require('../services/maintenanceService');
const { checkRateLimit } = require('../rateLimiter');
const { MAINTENANCE_SAMPLE_RATE } = require('../config');
const courseIds = require('../services/courseIds');

const router = express.Router();

router.post('/vote', async (req, res) => {
  const { winnerId, loserId } = req.body || {};

  if (typeof winnerId !== 'string' || typeof loserId !== 'string' || winnerId === loserId) {
    return res.status(400).json({ error: 'winnerId and loserId are required and must differ' });
  }
  if (!courseIds.has(winnerId) || !courseIds.has(loserId)) {
    return res.status(400).json({ error: 'unknown course id' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const { allowed, clientHash } = await checkRateLimit(ip);
  if (!allowed) {
    return res.status(429).json({ error: 'too many votes, slow down' });
  }

  try {
    const result = await castVote(winnerId, loserId, clientHash);
    // Fire-and-forget: never let a maintenance sample delay or fail a vote response.
    maybeRunMaintenance(MAINTENANCE_SAMPLE_RATE).catch(() => {});
    return res.json(result);
  } catch (err) {
    console.error('[vote] failed:', err);
    return res.status(500).json({ error: 'vote failed' });
  }
});

module.exports = router;
