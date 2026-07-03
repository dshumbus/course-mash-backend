const redis = require('../redisClient');
const { KEYS, BUDGET_BYTES, STORAGE_TIERS, DAILY_RETENTION_DAYS } = require('../config');

// Baseline footprint for the bounded structures (leaderboard ZSET,
// matches HASH, daily HASH, meta HASH) at ~676 courses. Used only by
// the fallback estimator below, never by the real INFO-based reading.
const BASELINE_BYTES = 200 * 1024; // ~200KB, generous overestimate
const AVG_VOTE_LOG_ENTRY_BYTES = 140; // measured JSON entry incl. Redis list overhead

/**
 * Ask Redis how much memory it's currently using. Upstash's REST
 * API passes most commands through, including INFO, so we parse
 * `used_memory` out of the memory section rather than relying on a
 * MEMORY USAGE walk over every key (slow, and unnecessary — INFO
 * gives us the whole instance's footprint in one call).
 *
 * Falls back to a cheap estimate if INFO isn't available on a given
 * plan/SDK version: since the vote log (cm:votelog) is the only
 * structure that scales with traffic, its length alone is a decent
 * proxy for total usage once you add the small fixed baseline for
 * the bounded leaderboard/stats structures.
 */
async function getUsedMemoryBytes() {
  try {
    const info = await redis.info('memory');
    const match = /used_memory:(\d+)/.exec(info);
    if (match) return Number(match[1]);
  } catch (err) {
    console.warn('[maintenance] INFO unavailable, falling back to estimate:', err.message);
  }
  const len = await redis.llen(KEYS.voteLog);
  return BASELINE_BYTES + len * AVG_VOTE_LOG_ENTRY_BYTES;
}

function tierFor(usedBytes) {
  const pct = usedBytes / BUDGET_BYTES;
  return STORAGE_TIERS.find((tier) => pct <= tier.maxPct) || STORAGE_TIERS[STORAGE_TIERS.length - 1];
}

function pruneDailyKeys(dailyObj) {
  const keys = Object.keys(dailyObj || {}).sort();
  return keys.slice(0, Math.max(0, keys.length - DAILY_RETENTION_DAYS));
}

/**
 * The core flush routine. Safe to call as often as you like —
 * it's cheap when there's nothing to do, and idempotent.
 *
 * What it NEVER touches, by design: cm:elo (leaderboard),
 * cm:matches (per-course match counts), cm:totalVotes. Those are
 * the "leaderboard and general stats" the whole system exists to
 * protect, and they're bounded by course count (~676 rows) rather
 * than by traffic, so they were never the storage risk to begin with.
 *
 * What it trims under pressure: cm:votelog (the only structure that
 * grows with vote volume) and, lightly, old entries in cm:daily
 * (bounded already, pruned mainly for tidiness).
 */
async function runMaintenance() {
  const usedBytes = await getUsedMemoryBytes();
  const tier = tierFor(usedBytes);
  const pctUsed = usedBytes / BUDGET_BYTES;

  const actions = [];

  // 1. Update the shared cap so every subsequent vote's Lua script
  //    trims the log to this new size on write (see voteScript.js).
  const prevCapRaw = await redis.hget(KEYS.meta, 'voteLogCap');
  const prevCap = prevCapRaw == null ? null : Number(prevCapRaw);
  if (prevCap !== tier.voteLogCap) {
    await redis.hset(KEYS.meta, { voteLogCap: tier.voteLogCap });
    actions.push(`voteLogCap ${prevCap ?? 'unset'} -> ${tier.voteLogCap}`);
  }

  // 2. Apply the new cap immediately rather than waiting for the
  //    next vote to trigger the trim — if traffic goes quiet right
  //    as we cross a threshold, we still want the memory back now.
  if (tier.voteLogCap <= 0) {
    const existed = await redis.exists(KEYS.voteLog);
    if (existed) {
      await redis.del(KEYS.voteLog);
      actions.push('votelog dropped entirely (critical tier)');
    }
  } else {
    const len = await redis.llen(KEYS.voteLog);
    if (len > tier.voteLogCap) {
      await redis.ltrim(KEYS.voteLog, 0, tier.voteLogCap - 1);
      actions.push(`votelog trimmed ${len} -> ${tier.voteLogCap}`);
    }
  }

  // 3. Prune stale daily-stats entries beyond the retention window.
  //    This hash is small regardless, so this is best-effort tidiness,
  //    not a memory-pressure response.
  const daily = await redis.hgetall(KEYS.daily);
  const staleKeys = pruneDailyKeys(daily);
  if (staleKeys.length > 0) {
    await redis.hdel(KEYS.daily, ...staleKeys);
    actions.push(`daily stats pruned: removed ${staleKeys.length} old day(s)`);
  }

  const snapshot = {
    usedBytes,
    pctUsed: Number(pctUsed.toFixed(4)),
    voteLogCap: tier.voteLogCap,
    ranAt: new Date().toISOString(),
    actions,
  };

  await redis.hset(KEYS.meta, {
    lastMaintenanceAt: snapshot.ranAt,
    lastUsedBytes: usedBytes,
    lastPctUsed: snapshot.pctUsed,
  });

  // Keep a short, capped history of maintenance runs — capped list,
  // so this itself can never become the next storage problem.
  if (actions.length > 0) {
    await redis.lpush(KEYS.maintLog, JSON.stringify(snapshot));
    await redis.ltrim(KEYS.maintLog, 0, 49); // last 50 runs that actually did something
  }

  return snapshot;
}

/**
 * Cheap, best-effort trigger meant to be called from the vote route
 * on a small sample of requests (see config.MAINTENANCE_SAMPLE_RATE),
 * so storage pressure gets checked continuously during real traffic
 * without adding an INFO round trip to every single vote. Errors are
 * swallowed here — a failed maintenance sample should never break a
 * user's vote. A dedicated maintenance endpoint/cron (see routes/
 * maintenance.js) provides a guaranteed-to-run backstop for quiet
 * periods.
 */
async function maybeRunMaintenance(sampleRate) {
  if (Math.random() >= 1 / sampleRate) return null;
  try {
    return await runMaintenance();
  } catch (err) {
    console.error('[maintenance] sampled run failed:', err.message);
    return null;
  }
}

async function getStorageStatus() {
  const [usedBytes, meta] = await Promise.all([
    getUsedMemoryBytes(),
    redis.hgetall(KEYS.meta),
  ]);
  return {
    usedBytes,
    budgetBytes: BUDGET_BYTES,
    pctUsed: Number((usedBytes / BUDGET_BYTES).toFixed(4)),
    currentTier: tierFor(usedBytes),
    meta: meta || {},
  };
}

module.exports = { runMaintenance, maybeRunMaintenance, getStorageStatus, getUsedMemoryBytes };
