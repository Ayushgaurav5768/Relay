import { getRedis } from '@relay/lib/redis.js';
import { config } from '@relay/lib/config.js';
import { createLogger } from '@relay/lib/logger.js';

const log = createLogger({ service: 'ingest' });

const REFILL_SCRIPT = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local intervalMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if not tokens then
  tokens = maxTokens
  ts = now
end

local elapsed = now - ts
local refill = elapsed * (maxTokens / intervalMs)
tokens = math.min(maxTokens, tokens + refill)

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, intervalMs * 2)
  return {1, math.floor(tokens)}
else
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, intervalMs * 2)
  return {0, 0}
end
`;

export function rateLimiter(req, res, next) {
  const apiKey = req.api_key;
  if (!apiKey) {
    next();
    return;
  }

  const redis = getRedis();
  const key = `ratelimit:ingest:${apiKey}`;
  const maxTokens = config.INGEST_RATE_LIMIT_RATE;
  const intervalMs = config.INGEST_RATE_LIMIT_INTERVAL_MS;
  const now = Date.now();

  redis.eval(REFILL_SCRIPT, 1, key, String(maxTokens), String(intervalMs), String(now))
    .then((result) => {
      const allowed = result[0];
      if (allowed === 0) {
        res.status(429).json({ error: 'rate limit exceeded' });
        return;
      }
      next();
    })
    .catch((err) => {
      log.warn({ err }, 'rate limiter error, allowing request');
      next();
    });
}
