const redis = require('../redisClient');
const { VOTE_SCRIPT } = require('../lua/voteScript');
const { ELO, KEYS } = require('../config');

/**
 * Cast one vote (winner beat loser) as a single atomic Redis
 * transaction. Elo is computed server-side inside the Lua script,
 * so a client can never forge its own rating delta by editing
 * request payloads or replaying old responses.
 */
async function castVote(winnerId, loserId, clientHash = '') {
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const now = String(Date.now());

  const result = await redis.eval(
    VOTE_SCRIPT,
    [KEYS.elo, KEYS.matches, KEYS.totalVotes, KEYS.daily, KEYS.voteLog, KEYS.meta],
    [
      winnerId,
      loserId,
      String(ELO.K),
      String(ELO.DEFAULT),
      String(ELO.MIN),
      String(ELO.MAX),
      dayKey,
      now,
      clientHash,
    ]
  );

  const [newWinnerElo, newLoserElo, winnerMatches, loserMatches, totalVotes] = result;
  return {
    winner: { id: winnerId, elo: Number(newWinnerElo), matches: Number(winnerMatches) },
    loser: { id: loserId, elo: Number(newLoserElo), matches: Number(loserMatches) },
    totalVotes: Number(totalVotes),
  };
}

/**
 * Full leaderboard: every course's current Elo, ordered highest
 * first. This reads only from cm:elo (a ZSET), so its cost and
 * size scale with course count (~676), never with vote count.
 */
async function getLeaderboard() {
  const raw = await redis.zrange(KEYS.elo, 0, -1, { rev: true, withScores: true });
  // @upstash/redis has returned withScores results either as a flat
  // [member, score, member, score, ...] array or as [{member, score}, ...]
  // objects depending on SDK version. Handle both so this doesn't
  // silently break on an upgrade.
  const rows = [];
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null) {
    for (const entry of raw) rows.push({ id: entry.member, elo: Number(entry.score) });
  } else {
    for (let i = 0; i < raw.length; i += 2) {
      rows.push({ id: raw[i], elo: Number(raw[i + 1]) });
    }
  }
  return rows;
}

/**
 * Match counts for every course, e.g. to show "N/676 courses ranked"
 * without shipping the raw vote log to the client.
 */
async function getMatchCounts() {
  const raw = await redis.hgetall(KEYS.matches);
  const out = {};
  if (raw) {
    for (const [id, count] of Object.entries(raw)) out[id] = Number(count);
  }
  return out;
}

async function getStats() {
  const [totalVotes, daily] = await Promise.all([
    redis.get(KEYS.totalVotes),
    redis.hgetall(KEYS.daily),
  ]);
  const dayKey = new Date().toISOString().slice(0, 10);
  return {
    totalVotes: Number(totalVotes || 0),
    votesToday: Number((daily && daily[dayKey]) || 0),
  };
}

module.exports = { castVote, getLeaderboard, getMatchCounts, getStats };
