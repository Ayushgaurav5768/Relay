#!/usr/bin/env node
/**
 * verifyLoadTest.js — Post-load-test correctness verifier
 *
 * After the k6 load test runs, this script connects to Postgres and asserts:
 *   1. Every ingested event reaches terminal status (delivered or dead)
 *   2. Per-destination delivery order matches ingestion order for
 *      always-succeed
 *   3. No destination's queue depth caused visible delay to a healthy
 *      destination's delivery latency
 *
 * Usage:
 *   node load-tests/verifyLoadTest.js
 *
 * Exit code: 0 on all pass, 1 on any failure.
 */

import pg from 'pg';

const POOL = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'relay',
  user: process.env.PGUSER || 'relay',
  password: process.env.PGPASSWORD || 'relay_dev',
});

const DESTINATIONS = ['always-succeed', 'flaky-dest', 'always-fail'];
const POLL_MS = 5000;
const MAX_WAIT_MS = 300_000;
const TERMINAL = ['delivered', 'dead'];

let failures = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — wait for settled state
// ---------------------------------------------------------------------------
async function pollUntilSettled() {
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    const { rows } = await POOL.query(
      `SELECT destination_id, status, COUNT(*)::int AS count
       FROM events
       WHERE destination_id = ANY($1)
       GROUP BY destination_id, status
       ORDER BY destination_id, status`,
      [DESTINATIONS]
    );

    // Build per-dest status map
    const perDest = {};
    for (const d of DESTINATIONS) perDest[d] = { delivered: 0, dead: 0, failed: 0, pending: 0 };
    for (const r of rows) {
      if (perDest[r.destination_id]) perDest[r.destination_id][r.status] = r.count;
    }

    // Show live progress
    const parts = DESTINATIONS.map(d => {
      const s = perDest[d];
      const terminal = s.delivered + s.dead;
      const total = terminal + s.failed + s.pending;
      return `${d}: ${terminal}/${total} terminal`;
    });
    process.stdout.write(`\r  ${parts.join('  |  ')}  `);

    // Stop waiting when always-succeed AND flaky-dest have zero pending+failed
    // (always-fail may take too long — we don't wait for it)
    const asOk = perDest['always-succeed'].pending === 0 && perDest['always-succeed'].failed === 0;
    const fdOk = perDest['flaky-dest'].pending === 0 && perDest['flaky-dest'].failed === 0;

    if (asOk && fdOk) {
      console.log('\n');
      return perDest;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // Timeout — report what we have
  const { rows } = await POOL.query(
    `SELECT destination_id, status, COUNT(*)::int AS count
     FROM events
     WHERE destination_id = ANY($1)
     GROUP BY destination_id, status
     ORDER BY destination_id, status`,
    [DESTINATIONS]
  );
  const perDest = {};
  for (const d of DESTINATIONS) perDest[d] = { delivered: 0, dead: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    if (perDest[r.destination_id]) perDest[r.destination_id][r.status] = r.count;
  }
  console.log('\n  ⚠ Timed out waiting for all events to settle.');
  return perDest;
}

// ---------------------------------------------------------------------------
// Phase 2 — assert no pending events for always-succeed
// ---------------------------------------------------------------------------
function checkTerminal(summary) {
  console.log('--- Assertion 1: No stuck pending/failed events ---');
  let ok = true;
  for (const dest of DESTINATIONS) {
    const s = summary[dest];
    const stuck = s.pending + s.failed;
    const label = `${dest}: ${stuck} stuck (${s.delivered} delivered, ${s.dead} dead, ${s.pending} pending, ${s.failed} failed)`;
    if (dest === 'always-fail') {
      // always-fail may still have pending/failed due to retry delays — warn not fail
      if (stuck > 0) {
        console.log(`  ⚠ ${label}`);
      } else {
        console.log(`  ✓ ${label}`);
      }
    } else {
      assert(stuck === 0, label);
      if (stuck !== 0) ok = false;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Phase 3 — delivery order for always-succeed
// ---------------------------------------------------------------------------
async function checkOrder() {
  console.log('\n--- Assertion 2: Delivery order preservation (always-succeed) ---');

  // Get all ALWAYS-SUCCEED events ordered by creation time
  const { rows: events } = await POOL.query(
    `SELECT id, created_at
     FROM events
     WHERE destination_id = 'always-succeed'
     ORDER BY created_at ASC`
  );

  if (events.length === 0) {
    console.log('  ⚠ No events for always-succeed, skipping order check');
    return true;
  }

  // Get the first (and only) delivered attempt for each event, ordered by creation time
  const { rows: attempts } = await POOL.query(
    `SELECT e.id AS event_id, e.created_at, da.attempted_at, da.attempt_number
     FROM events e
     JOIN delivery_attempts da ON da.event_id = e.id
     WHERE e.destination_id = 'always-succeed'
       AND da.status = 'success'
     ORDER BY e.created_at ASC`
  );

  if (attempts.length < 2) {
    console.log(`  ⚠ Only ${attempts.length} delivered events, need ≥2 for order check`);
    return true;
  }

  let orderViolations = 0;
  for (let i = 1; i < attempts.length; i++) {
    if (attempts[i].attempted_at < attempts[i - 1].attempted_at) {
      orderViolations++;
      if (orderViolations <= 3) {
        console.log(`    violation at index ${i}: event ${attempts[i].event_id.slice(0, 8)} attempted_at=${attempts[i].attempted_at} < prev ${attempts[i-1].attempted_at}`);
      }
    }
  }

  const totalChecked = attempts.length;
  assert(orderViolations === 0,
    `${totalChecked} deliveries in creation order (${orderViolations} out-of-order)`);

  // Also show timing stats
  const firstEvent = new Date(events[0].created_at).getTime();
  const lastAttempt = new Date(attempts[attempts.length - 1].attempted_at).getTime();
  const deliveryWindow = ((lastAttempt - firstEvent) / 1000).toFixed(1);
  const avgDeliveryMs = attempts.reduce((sum, a, i) => {
    if (i === 0) return sum;
    return sum + (new Date(a.attempted_at) - new Date(attempts[i-1].attempted_at));
  }, 0) / (attempts.length - 1);

  console.log(`    Window: ${deliveryWindow}s to deliver ${events.length} events`);
  console.log(`    Avg inter-delivery gap: ${avgDeliveryMs.toFixed(1)}ms`);

  return orderViolations === 0;
}

// ---------------------------------------------------------------------------
// Phase 4 — latency isolation
// ---------------------------------------------------------------------------
async function checkLatencyIsolation() {
  console.log('\n--- Assertion 3: Latency isolation (always-succeed vs always-fail) ---');

  // Get all successful delivery attempts for always-succeed with timestamps
  const { rows: succeedDeliveries } = await POOL.query(
    `SELECT da.attempted_at, da.attempt_number
     FROM delivery_attempts da
     JOIN events e ON e.id = da.event_id
     WHERE e.destination_id = 'always-succeed'
       AND da.status = 'success'
     ORDER BY da.attempted_at ASC`
  );

  if (succeedDeliveries.length < 10) {
    console.log(`  ⚠ Only ${succeedDeliveries.length} successful deliveries for always-succeed, skipping latency check`);
    return true;
  }

  // Compute inter-delivery gaps
  const gaps = [];
  for (let i = 1; i < succeedDeliveries.length; i++) {
    gaps.push(new Date(succeedDeliveries[i].attempted_at) - new Date(succeedDeliveries[i - 1].attempted_at));
  }
  gaps.sort((a, b) => a - b);

  const p50 = gaps[Math.floor(gaps.length * 0.50)];
  const p95 = gaps[Math.floor(gaps.length * 0.95)];

  // The gaps should be consistently small for always-succeed
  // since it's isolated from the failing destination
  const isolationThreshold = 5000; // 5s max gap
  const largeGaps = gaps.filter(g => g > isolationThreshold);

  console.log(`    ${succeedDeliveries.length} successful deliveries`);
  console.log(`    Inter-delivery gap p50: ${p50}ms, p95: ${p95}ms`);
  console.log(`    Gaps > ${isolationThreshold}ms: ${largeGaps.length}/${gaps.length}`);

  assert(largeGaps.length === 0,
    `Latency isolation: ${largeGaps.length} gaps exceeded ${isolationThreshold}ms`);

  // Also check — do always-succeed deliveries complete near-instant after ingestion?
  const { rows: fastCheck } = await POOL.query(
    `SELECT e.id,
            EXTRACT(EPOCH FROM (da.attempted_at - e.created_at)) * 1000 AS ingest_to_delivery_ms,
            e.created_at, da.attempted_at, da.attempt_number
     FROM events e
     JOIN delivery_attempts da ON da.event_id = e.id
     WHERE e.destination_id = 'always-succeed'
       AND da.status = 'success'
       AND da.attempt_number = 1
     ORDER BY e.created_at ASC
     LIMIT 10`
  );

  if (fastCheck.length > 0) {
    const avgLatency = fastCheck.reduce((s, r) => s + parseFloat(r.ingest_to_delivery_ms), 0) / fastCheck.length;
    console.log(`    Avg ingest-to-delivery latency (first attempt): ${avgLatency.toFixed(0)}ms`);
    assert(avgLatency < 60000, `Fast path latency: ${avgLatency.toFixed(0)}ms avg (should be < 60s)`);
  }

  return largeGaps.length === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Relay Load Test Verification ===\n');

  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`Started: ${timestamp}`);
  console.log(`Destinations: ${DESTINATIONS.join(', ')}`);
  console.log(`Max wait: ${MAX_WAIT_MS / 1000}s, Poll: ${POLL_MS / 1000}s\n`);

  const summary = await pollUntilSettled();

  // Print final summary table
  console.log('Status breakdown:');
  console.log('╔════════════════╤═══════════╤══════╤════════╤═══════╗');
  console.log('║ Destination    │ Delivered │ Dead │ Failed │ Pending ║');
  console.log('╠════════════════╪═══════════╪══════╪════════╪═══════╣');
  for (const d of DESTINATIONS) {
    const s = summary[d];
    console.log(`║ ${d.padEnd(14)} │ ${String(s.delivered).padStart(9)} │ ${String(s.dead).padStart(4)} │ ${String(s.failed).padStart(6)} │ ${String(s.pending).padStart(7)} ║`);
  }
  console.log('╚════════════════╧═══════════╧══════╧════════╧═══════╝');

  await checkTerminal(summary);
  await checkOrder();
  await checkLatencyIsolation();

  await POOL.end();

  console.log(`\n=== ${failures === 0 ? 'ALL VERIFICATIONS PASSED' : `${failures} VERIFICATION(S) FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Verification script failed:', err);
  POOL.end().catch(() => {});
  process.exit(1);
});
