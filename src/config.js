// ============================================================
// Central config: Redis key names, Elo tuning, and the storage
// budget that drives the auto-flush behavior in maintenanceService.
// ============================================================

// Elo tuning — mirrors the values already used client-side in
// course_mash.html so ratings stay compatible if you ever migrate
// existing window.storage data into Redis.
const ELO = {
  K: 32,
  DEFAULT: 1500,
  MIN: 100,
  MAX: 3000,
};

// Redis keys. Everything is namespaced under "cm:" (Course Mash).
//
//  cm:elo        ZSET   member=courseId  score=elo rating   -> ~676 members, doubles as the leaderboard
//  cm:matches    HASH   field=courseId   value=matchCount   -> ~676 fields, tiny ints
//  cm:totalVotes STRING integer counter
//  cm:daily      HASH   field=YYYY-MM-DD value=count        -> pruned, only recent days kept
//  cm:votelog    LIST   JSON vote events, newest first       -> the ONLY structure that can grow
//                                                                unbounded; this is what maintenance trims
//  cm:meta       HASH   operational state (current log cap, last maintenance run, usage snapshot)
//  cm:maintlog   LIST   short capped history of maintenance actions taken (for observability)
//  cm:rl:<hash>  STRING per-IP vote rate limit, self-expiring via TTL (never a growth risk)
const KEYS = {
  elo: 'cm:elo',
  matches: 'cm:matches',
  totalVotes: 'cm:totalVotes',
  daily: 'cm:daily',
  voteLog: 'cm:votelog',
  meta: 'cm:meta',
  maintLog: 'cm:maintlog',
  rateLimitPrefix: 'cm:rl:',
};

// ------------------------------------------------------------
// Storage budget. Upstash's free tier is 256MB; we target 250MB
// and leave headroom because Upstash's own bookkeeping (and the
// fact that "used memory" as reported can lag slightly behind
// actual writes) eats a little of that.
//
// The leaderboard (cm:elo), match counts (cm:matches), and vote
// totals (cm:totalVotes / cm:daily) are all bounded by course
// count (~676), not by vote count — so they will never meaningfully
// contribute to storage pressure. The vote log is the only thing
// that grows with traffic, so it is the only thing maintenance
// ever trims or drops.
// ------------------------------------------------------------
const BUDGET_BYTES = 250 * 1024 * 1024; // 250MB

// Tiered response as we approach the budget. Percentages are of
// BUDGET_BYTES. Each tier sets the max length the vote log is
// trimmed down to; lower tiers cap it, the top tier drops it.
const STORAGE_TIERS = [
  { maxPct: 0.60, voteLogCap: 5000 },  // healthy — keep a decent recent-activity window
  { maxPct: 0.75, voteLogCap: 1500 },  // getting full — shrink the window
  { maxPct: 0.90, voteLogCap: 300 },   // tight — keep just enough for abuse checks
  { maxPct: 1.01, voteLogCap: 0 },     // critical — drop the log entirely, protect the essentials
];

// How many days of the `cm:daily` hash to retain. This hash is tiny
// (one field per day) so it's not a real storage risk, but we still
// prune it for tidiness and to bound iteration cost.
const DAILY_RETENTION_DAYS = 30;

// Run the storage-pressure check roughly once every N votes rather
// than on every single request (an INFO call has a small cost, and
// pressure changes slowly). Also exposed as a standalone maintenance
// endpoint/cron for guaranteed regular checks even during quiet periods.
const MAINTENANCE_SAMPLE_RATE = 200; // ~0.5% of votes trigger an inline check

// Simple abuse guard: minimum ms between votes accepted from the same
// IP, enforced server-side (the frontend already throttles at 400ms,
// this is the trust boundary since client throttling can be bypassed).
const RATE_LIMIT_MS = 350;

module.exports = {
  ELO,
  KEYS,
  BUDGET_BYTES,
  STORAGE_TIERS,
  DAILY_RETENTION_DAYS,
  MAINTENANCE_SAMPLE_RATE,
  RATE_LIMIT_MS,
};
