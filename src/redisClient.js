require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { Redis } = require('@upstash/redis');

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Copy .env.local and fill them in.'
  );
}

// Redis.fromEnv() also works since these are the SDK's default env
// var names, but constructing explicitly keeps the dependency obvious.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = redis;
