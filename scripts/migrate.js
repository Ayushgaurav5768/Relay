#!/usr/bin/env node

/**
 * Database migration runner.
 *
 * Reads .sql files from db/migrations/ (sorted lexically), tracks applied
 * migrations in the _migrations table, and applies any new ones in order.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * Environment: expects standard PG* env vars (PGHOST, PGPORT, PGDATABASE,
 * PGUSER, PGPASSWORD) as loaded by @relay/lib/config.js.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '@relay/lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

async function migrate() {
  const pool = getPool();

  // Ensure the migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Fetch already-applied migrations
  const { rows: applied } = await pool.query(
    'SELECT name FROM _migrations ORDER BY name'
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`SKIP  ${file} (already applied)`);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    // Run inside a transaction so a failed migration rolls back cleanly
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (name) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`OK    ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAIL  ${file}: ${err.message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await closePool();
  console.log('Done.');
}

migrate().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
