import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

let pool = null;

/**
 * Get or create the PostgreSQL connection pool.
 * @returns {import('pg').Pool}
 */
export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: config.PGHOST,
      port: config.PGPORT,
      database: config.PGDATABASE,
      user: config.PGUSER,
      password: config.PGPASSWORD,
      max: 10,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 3000,
    });

    pool.on('error', (err) => {
      console.error('pg pool error', err);
    });
  }
  return pool;
}

/**
 * Execute a parameterised query on the pool.
 * @param {string} text - SQL with $1, $2, … placeholders
 * @param {any[]} [params] - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

/**
 * Execute work inside a managed transaction.
 * The callback receives a `pg.PoolClient` and **must** use it for all queries.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check database connectivity.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function checkDb() {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Gracefully shut down the pool.
 * @returns {Promise<void>}
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
