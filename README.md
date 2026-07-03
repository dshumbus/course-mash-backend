# Course Mash backend (Redis / Upstash free tier)

Server-side Elo voting + leaderboard for Course Mash, built to fit
comfortably inside Upstash's 256MB free tier with room to spare —
and to actively defend that budget under sustained traffic instead
of just hoping it never fills up.

## Why this design

**The leaderboard and stats are bounded by course count, not vote
count.** There are 676 courses. The leaderboard (a Redis ZSET) and
match counters (a HASH) will always have ~676 entries no matter how
many millions of votes come in — maybe 20–30KB total. They were
never going to be the thing that fills up 250MB.

**The one thing that *does* grow with traffic is a raw vote-event
log** (`cm:votelog`), kept for abuse-pattern review and analytics.
Every vote appends to it. That's the only structure this system
needs to actively manage — so that's exactly what the flush
mechanism targets, while leaving the leaderboard and stats alone.

## Redis schema

| Key | Type | Contents | Grows with |
|---|---|---|---|
| `cm:elo` | ZSET | `member=courseId`, `score=elo` — doubles as the leaderboard | course count only (~676) |
| `cm:matches` | HASH | `field=courseId`, `value=matchCount` | course count only |
| `cm:totalVotes` | STRING | integer counter | never (single value) |
| `cm:daily` | HASH | `field=YYYY-MM-DD`, `value=count` | days elapsed (pruned to last 30) |
| `cm:votelog` | LIST | capped JSON vote events, newest first | **vote count — this is the risk** |
| `cm:meta` | HASH | operational state: current vote-log cap, last maintenance run/usage | fixed size |
| `cm:maintlog` | LIST | capped history of maintenance actions (last 50) | fixed size |
| `cm:rl:<hash>` | STRING | per-client rate limit, `PX`-expiring | self-cleaning, never grows |

## Atomic voting

`src/lua/voteScript.js` contains a Lua script run via a single
`EVAL`. It reads both courses' current Elo, computes the new ratings
*inside Redis*, writes both scores, increments match/vote counters,
appends+trims the vote log, and returns the result — all as one
atomic operation. This closes two problems at once:

1. **No race condition**: two simultaneous voters touching the same
   course can't read-modify-write on top of each other, because
   there's no gap between the read and the write for another request
   to land in.
2. **No client-trust hole**: Elo math never happens in the browser,
   so opening devtools and POSTing a forged rating delta does
   nothing — the server always recomputes it from the authoritative
   scores in Redis.

## Storage-pressure flush (`src/services/maintenanceService.js`)

Every vote's Lua script trims `cm:votelog` to whatever cap is
currently stored in `cm:meta.voteLogCap` (default 5000) — so the log
is bounded on every single write, not just when a periodic job runs.

On top of that, a maintenance pass (`runMaintenance()`) checks actual
Redis memory usage (`INFO memory`, with a length-based estimate as a
fallback if `INFO` isn't available) against the 250MB budget and
moves through tiers:

| Usage | Vote log cap |
|---|---|
| ≤ 60% | 5,000 recent events |
| ≤ 75% | 1,500 |
| ≤ 90% | 300 |
| > 90% | 0 (dropped entirely) |

The leaderboard, match counts, and vote totals are **never** touched
by any tier — they're excluded from the maintenance routine by
construction, not just by the current usage numbers.

Maintenance runs two ways:
- **Sampled inline**: ~0.5% of votes (`MAINTENANCE_SAMPLE_RATE` in
  `src/config.js`) trigger a check after the vote response is already
  sent, so it never slows down a user's vote and a failure there
  never breaks voting.
- **Guaranteed backstop**: `POST /api/admin/maintenance/run` (or
  `npm run maintenance`) for wiring into an external cron (Vercel
  Cron, a GitHub Actions schedule, plain crontab) so pressure gets
  checked regularly even during quiet periods with little traffic to
  sample from.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/vote` | rate-limited by IP | `{winnerId, loserId}` → atomic Elo update |
| `GET` | `/api/state` | none | full boot payload: rows (elo+matches), totals |
| `GET` | `/api/leaderboard` | none | leaderboard rows only |
| `GET` | `/api/admin/storage` | `Authorization: Bearer <ADMIN_TOKEN>` | current usage vs. budget, active tier |
| `POST` | `/api/admin/maintenance/run` | same | force an immediate flush pass |
| `GET` | `/api/health` | none | liveness check |

## Running it

```bash
npm install
npm run seed          # one-time: initializes all 676 courses at Elo 1500
npm start              # http://localhost:8787
```

`.env.local` already has your Upstash REST URL/token copied over from
the uploaded file — just set a real `ADMIN_TOKEN` before deploying
anywhere public, since that's what protects the maintenance endpoints.

### Frontend changes needed

`course_mash.html` currently calls `window.storage.get/set` directly.
Swap that for:
- On boot: `GET /api/state` instead of `loadState()`'s storage call.
- On vote: `POST /api/vote` with `{winnerId, loserId}` instead of the
  local `applyVote()` read-modify-write — the server now owns Elo
  math entirely, so the client just reports who won and renders
  whatever the response's `winner.elo`/`loser.elo` say (or ignores
  them, since the UI never shows raw ratings anyway).

### A note on SDK response shapes

I couldn't reach the npm registry from this sandbox to run this
against your live Upstash instance, so `@upstash/redis` calls were
written against its documented behavior rather than a live test run.
The one spot most likely to vary across SDK versions is
`zrange(..., {withScores: true})` — `getLeaderboard()` in
`src/services/eloService.js` already handles both response shapes
I've seen in the wild, but it's worth a smoke test (`npm run seed`
then hit `GET /api/state`) before you rely on it in production.
