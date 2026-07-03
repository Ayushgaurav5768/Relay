/**
 * Per-destination circuit breaker state machine backed by Redis.
 *
 * States:
 *   CLOSED    — Normal operation. Failures are counted; once the consecutive
 *               failure threshold is reached, the breaker trips to OPEN.
 *   OPEN      — Requests are short-circuited for a cooldown period. After
 *               the cooldown expires, the next probe transitions to HALF_OPEN.
 *   HALF_OPEN — A single probe is allowed. If it succeeds → CLOSED (failures
 *               reset). If it fails → OPEN with extended cooldown.
 *
 * Redis key:  cb:{destinationId}
 * Hash fields: state, failure_count, cooldown_until (ms), opened_at (ms), open_count
 *
 * Cooldown backoff formula (used in Lua scripts):
 *   cooldown = min(300, baseCooldownSeconds * 2^(open_count - 1))
 *
 *   Where open_count is the number of times the breaker has transitioned to OPEN.
 *   This gives: 30s, 60s, 120s, 240s, 300s (capped at 5 min).
 */

import { config } from './config.js';

const CB_ON_SUCCESS = `
local key = KEYS[1]
local now = tonumber(ARGV[1])

local state = redis.call('HGET', key, 'state')
if not state then
  redis.call('HMSET', key, 'state', 'CLOSED', 'failure_count', 0, 'open_count', 0)
  state = 'CLOSED'
end

redis.call('HSET', key, 'failure_count', 0)

if state == 'HALF_OPEN' then
  redis.call('HSET', key, 'state', 'CLOSED')
  redis.call('HDEL', key, 'cooldown_until')
end

redis.call('PEXPIRE', key, 86400000)
return {redis.call('HGET', key, 'state'), 0}
`;

const CB_ON_FAILURE = `
local key = KEYS[1]
local threshold = tonumber(ARGV[1])
local baseCooldown = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local state = redis.call('HGET', key, 'state')
if not state then
  state = 'CLOSED'
  redis.call('HSET', key, 'state', 'CLOSED', 'failure_count', 0, 'open_count', 0)
end

local failure_count = tonumber(redis.call('HGET', key, 'failure_count') or '0')
local open_count = tonumber(redis.call('HGET', key, 'open_count') or '0')

if state == 'CLOSED' then
  failure_count = failure_count + 1
  if failure_count >= threshold then
    open_count = open_count + 1
    local cooldown = math.min(300, baseCooldown * (2 ^ (open_count - 1)))
    redis.call('HMSET', key,
      'state', 'OPEN',
      'failure_count', failure_count,
      'open_count', open_count,
      'cooldown_until', now + (cooldown * 1000),
      'opened_at', now
    )
    redis.call('PEXPIRE', key, 86400000)
    return {'OPEN', failure_count, now + (cooldown * 1000), open_count}
  else
    redis.call('HSET', key, 'failure_count', failure_count)
    redis.call('PEXPIRE', key, 86400000)
    return {'CLOSED', failure_count, -1, open_count}
  end
elseif state == 'HALF_OPEN' then
  open_count = open_count + 1
  failure_count = failure_count + 1
  local cooldown = math.min(300, baseCooldown * (2 ^ (open_count - 1)))
  redis.call('HMSET', key,
    'state', 'OPEN',
    'failure_count', failure_count,
    'open_count', open_count,
    'cooldown_until', now + (cooldown * 1000),
    'opened_at', now
  )
  redis.call('PEXPIRE', key, 86400000)
  return {'OPEN', failure_count, now + (cooldown * 1000), open_count}
else
  failure_count = failure_count + 1
  redis.call('HSET', key, 'failure_count', failure_count)
  redis.call('PEXPIRE', key, 86400000)
  local cooldown_until = redis.call('HGET', key, 'cooldown_until') or ''
  return {'OPEN', failure_count, cooldown_until, open_count}
end
`;

const CB_PROBE_ALLOWED = `
local key = KEYS[1]
local now = tonumber(ARGV[1])

local state = redis.call('HGET', key, 'state')
if not state then
  redis.call('HMSET', key, 'state', 'CLOSED', 'failure_count', 0, 'open_count', 0)
  redis.call('PEXPIRE', key, 86400000)
  return {1, 'CLOSED', -1}
end

if state == 'CLOSED' then
  return {1, 'CLOSED', -1}
end

if state == 'HALF_OPEN' then
  return {1, 'HALF_OPEN', -1}
end

local cooldown_until = tonumber(redis.call('HGET', key, 'cooldown_until') or '0')
if cooldown_until <= now then
  redis.call('HSET', key, 'state', 'HALF_OPEN')
  redis.call('PEXPIRE', key, 86400000)
  return {1, 'HALF_OPEN', -1}
else
  local retry_after = cooldown_until - now
  return {0, 'OPEN', math.floor(retry_after)}
end
`;

const CB_GET_STATE = `
local key = KEYS[1]
local state = redis.call('HGET', key, 'state')
if not state then
  return {'CLOSED', 0, -1, -1, 0}
end
local failure_count = tonumber(redis.call('HGET', key, 'failure_count') or '0')
local cooldown_until = tonumber(redis.call('HGET', key, 'cooldown_until') or '-1')
local opened_at = tonumber(redis.call('HGET', key, 'opened_at') or '-1')
local open_count = tonumber(redis.call('HGET', key, 'open_count') or '0')
return {state, failure_count, cooldown_until, opened_at, open_count}
`;

export class CircuitBreaker {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {string} destinationId
   * @param {Object} [options]
   * @param {number} [options.threshold] - Consecutive failures before tripping (default: config.CB_FAILURE_THRESHOLD)
   * @param {number} [options.baseCooldown] - Base cooldown in seconds (default: config.CB_COOLDOWN_SECONDS)
   */
  constructor(redis, destinationId, options = {}) {
    this.redis = redis;
    this.key = `cb:${destinationId}`;
    this.threshold = options.threshold ?? config.CB_FAILURE_THRESHOLD;
    this.baseCooldown = options.baseCooldown ?? config.CB_COOLDOWN_SECONDS;
  }

  /**
   * Record a successful delivery.
   * @returns {Promise<{state: string, failure_count: number}>}
   */
  async onSuccess() {
    const result = await this.redis.eval(CB_ON_SUCCESS, 1, this.key, String(Date.now()));
    return {
      state: result[0],
      failure_count: result[1],
    };
  }

  /**
   * Record a failed delivery.
   * @returns {Promise<{state: string, failure_count: number, cooldown_until: number, open_count: number}>}
   */
  async onFailure() {
    const result = await this.redis.eval(
      CB_ON_FAILURE, 1, this.key,
      String(this.threshold),
      String(this.baseCooldown),
      String(Date.now())
    );
    return {
      state: result[0],
      failure_count: result[1],
      cooldown_until: result[2],
      open_count: result[3],
    };
  }

  /**
   * Check whether a probe (delivery attempt) is allowed.
   * Transitions OPEN→HALF_OPEN automatically if the cooldown has expired.
   * @returns {Promise<{allowed: boolean, state: string, retry_after: number}>}
   */
  async isProbeAllowed() {
    const result = await this.redis.eval(CB_PROBE_ALLOWED, 1, this.key, String(Date.now()));
    return {
      allowed: result[0] === 1,
      state: result[1],
      retry_after: result[2],
    };
  }

  /**
   * Get the current circuit breaker state without side effects.
   * @returns {Promise<{state: string, failure_count: number, cooldown_until: number, opened_at: number, open_count: number}>}
   */
  async getState() {
    const result = await this.redis.eval(CB_GET_STATE, 1, this.key);
    return {
      state: result[0],
      failure_count: result[1],
      cooldown_until: result[2],
      opened_at: result[3],
      open_count: result[4],
    };
  }

  /**
   * Reset the circuit breaker for this destination (testing / manual override).
   * @returns {Promise<void>}
   */
  async reset() {
    await this.redis.del(this.key);
  }
}
