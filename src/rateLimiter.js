const crypto = require('crypto');
const redis = require('./redisClient');
const { KEYS, RATE_LIMIT_MS } = require('./config');

// Salted so raw IPs never sit in Redis (privacy, and it means the
// key name itself leaks nothing if ever inspected).
const SALT = process.env.IP_HASH_SALT || 'coursemash-default-salt-change-me';

function hashClient(ip) {
  return crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 16);
}

/**
 * Returns { allowed, clientHash }. Uses SET ... NX PX so the whole
 * check-and-mark is one atomic round trip, and the key expires on
 * its own — no cleanup job needed, and it can never contribute to
 * storage growth since it self-deletes after RATE_LIMIT_MS.
 */
async function checkRateLimit(ip) {
  const clientHash = hashClient(ip || 'unknown');
  const key = KEYS.rateLimitPrefix + clientHash;
  const set = await redis.set(key, '1', { nx: true, px: RATE_LIMIT_MS });
  return { allowed: set === 'OK' || set === true, clientHash };
}

module.exports = { checkRateLimit, hashClient };
