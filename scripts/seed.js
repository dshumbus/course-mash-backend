// Seeds every course from data/courses.json into the leaderboard
// with the default Elo rating — but only if it isn't already there,
// so re-running this after real votes have come in is always safe
// (uses ZADD NX under the hood).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const redis = require('../src/redisClient');
const { ELO, KEYS } = require('../src/config');
const courses = require('../data/courses.json');

async function main() {
  console.log(`Seeding ${courses.length} courses at default Elo ${ELO.DEFAULT}...`);

  const CHUNK = 100;
  let added = 0;
  for (let i = 0; i < courses.length; i += CHUNK) {
    const chunk = courses.slice(i, i + CHUNK);
    // @upstash/redis's zadd wants each member as its own {score, member}
    // object, spread as separate arguments — not a single {member: score}
    // map (that shape produces "null args" errors on the wire).
    const entries = chunk.map((c) => ({ score: ELO.DEFAULT, member: c.id }));
    // nx: true -> only sets courses that don't already have a score,
    // so existing ratings from real votes are never reset.
    const result = await redis.zadd(KEYS.elo, { nx: true }, ...entries);
    added += result;
    console.log(`  ...${Math.min(i + CHUNK, courses.length)}/${courses.length}`);
  }

  // Also make sure the meta hash has a starting vote-log cap so the
  // first votes don't rely on the Lua script's hardcoded default.
  await redis.hset(KEYS.meta, { voteLogCap: 5000 });

  console.log(`Done. ${added} new course(s) added (existing ratings left untouched).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
