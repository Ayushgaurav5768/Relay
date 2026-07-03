#!/usr/bin/env node
/**
 * Creates the three load-test destinations used by the k6 script.
 *
 * Run this BEFORE the k6 load test:
 *   node load-tests/seed-load-test.js
 *
 * Safe to run repeatedly — uses ON CONFLICT DO NOTHING.
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'relay',
  user: process.env.PGUSER || 'relay',
  password: process.env.PGPASSWORD || 'relay_dev',
});

const DESTINATIONS = [
  {
    id: 'always-succeed',
    owner_id: 'org_acme',
    url: 'http://flaky-server:9099/succeed',
    secret: 'whsec_succeed',
    status: 'active',
  },
  {
    id: 'flaky-dest',
    owner_id: 'org_acme',
    url: 'http://flaky-server:9099/webhook',
    secret: 'whsec_flaky',
    status: 'active',
  },
  {
    id: 'always-fail',
    owner_id: 'org_acme',
    url: 'http://flaky-server:9099/fail',
    secret: 'whsec_fail',
    status: 'active',
  },
];

async function seed() {
  for (const d of DESTINATIONS) {
    await pool.query(
      `INSERT INTO destinations (id, owner_id, url, secret, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.owner_id, d.url, d.secret, d.status]
    );
    console.log(`+ destination '${d.id}' (${d.url})`);
  }
  await pool.end();
  console.log('Seed complete — 3 load-test destinations ready.');
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
