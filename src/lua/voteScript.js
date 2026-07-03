// ============================================================
// Atomic vote script.
//
// Runs entirely inside Redis via EVAL, so a read (current Elo),
// modify (compute new Elo), write (persist + log + trim) cycle
// never races against a concurrent vote — there is no
// get-then-set gap for two simultaneous voters to step on.
//
// KEYS[1] = cm:elo        (ZSET, member=courseId score=elo)
// KEYS[2] = cm:matches    (HASH, field=courseId value=matchCount)
// KEYS[3] = cm:totalVotes (STRING counter)
// KEYS[4] = cm:daily      (HASH, field=YYYY-MM-DD value=count)
// KEYS[5] = cm:votelog    (LIST, capped JSON vote events)
// KEYS[6] = cm:meta       (HASH, operational state incl. current log cap)
//
// ARGV[1] = winnerId
// ARGV[2] = loserId
// ARGV[3] = K factor
// ARGV[4] = default Elo (used only if a course has no score yet)
// ARGV[5] = Elo floor
// ARGV[6] = Elo ceiling
// ARGV[7] = day key, e.g. "2026-07-03"
// ARGV[8] = now (ms since epoch, from app clock — Redis has no clock access here)
// ARGV[9] = client hash (salted IP hash, for abuse-pattern review; '' if unavailable)
// ============================================================
const VOTE_SCRIPT = `
local winner   = ARGV[1]
local loser    = ARGV[2]
local K        = tonumber(ARGV[3])
local defElo   = tonumber(ARGV[4])
local eloMin   = tonumber(ARGV[5])
local eloMax   = tonumber(ARGV[6])
local dayKey   = ARGV[7]
local now      = ARGV[8]
local clientId = ARGV[9]

if winner == loser then
  return redis.error_reply('winner and loser must differ')
end

local function clampRound(v)
  if v < eloMin then v = eloMin end
  if v > eloMax then v = eloMax end
  return math.floor(v + 0.5)
end

local wScore = tonumber(redis.call('ZSCORE', KEYS[1], winner))
if wScore == nil then wScore = defElo end
local lScore = tonumber(redis.call('ZSCORE', KEYS[1], loser))
if lScore == nil then lScore = defElo end

local ea = 1 / (1 + math.pow(10, (lScore - wScore) / 400))
local eb = 1 - ea

local newW = clampRound(wScore + K * (1 - ea))
local newL = clampRound(lScore + K * (0 - eb))

redis.call('ZADD', KEYS[1], newW, winner)
redis.call('ZADD', KEYS[1], newL, loser)

local wMatches = redis.call('HINCRBY', KEYS[2], winner, 1)
local lMatches = redis.call('HINCRBY', KEYS[2], loser, 1)

local totalVotes = redis.call('INCR', KEYS[3])
redis.call('HINCRBY', KEYS[4], dayKey, 1)

-- Append to the capped vote log, then immediately trim to whatever
-- cap maintenance has currently set (default 5000 if never set).
-- This keeps the log bounded on *every single write*, not just when
-- a periodic maintenance job happens to run.
local cap = tonumber(redis.call('HGET', KEYS[6], 'voteLogCap'))
if cap == nil then cap = 5000 end

if cap <= 0 then
  redis.call('DEL', KEYS[5])
else
  local entry = cjson.encode({
    t = now, w = winner, l = loser, c = clientId
  })
  redis.call('LPUSH', KEYS[5], entry)
  redis.call('LTRIM', KEYS[5], 0, cap - 1)
end

return { newW, newL, wMatches, lMatches, totalVotes }
`;

module.exports = { VOTE_SCRIPT };
