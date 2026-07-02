import Redis from 'ioredis';
import { config } from './config.js';

let client = null;

/**
 * Get or create the Redis client.
 * @returns {import('ioredis').Redis}
 */
export function getRedis() {
  if (!client) {
    client = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      lazyConnect: true,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

    client.on('error', (err) => {
      console.error('redis error', err);
    });
  }
  return client;
}

/**
 * Check Redis connectivity.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function checkRedis() {
  try {
    const redis = getRedis();
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect();
    }
    await redis.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Gracefully quit Redis.
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
  }
}
