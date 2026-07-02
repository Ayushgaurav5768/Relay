#!/usr/bin/env node

/**
 * Seed script — creates test destinations pointing at the flaky endpoint
 * test server and inserts a handful of sample events with delivery
 * attempts so the dashboard has data to render immediately.
 *
 * Usage:
 *   node scripts/seed.js
 *
 * Safe to run repeatedly — uses INSERT … ON CONFLICT DO NOTHING for
 * destinations so it's idempotent.
 */

import { getPool, closePool } from '@relay/lib/db.js';
import { DestinationRepository } from '@relay/lib/repositories/DestinationRepository.js';
import { EventRepository } from '@relay/lib/repositories/EventRepository.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@relay/lib/logger.js';

const log = createLogger({ service: 'seed' });

async function seed() {
  const pool = getPool();
  const destRepo = new DestinationRepository();
  const eventRepo = new EventRepository();
  const attemptRepo = new DeliveryAttemptRepository();

  // ── Destinations ────────────────────────────────────────────
  // Both point at the flaky-endpoint-test-server running inside
  // Docker Compose. The flaky server alternates success/failure
  // on a global counter — see services/flaky-endpoint-test-server/index.js.
  const destinations = [
    {
      id: 'acme-orders',
      owner_id: 'org_acme',
      url: 'http://flaky-server:9099/webhook',
      secret: 'whsec_acme_orders',
      status: 'active',
    },
    {
      id: 'payments-stripe',
      owner_id: 'org_acme',
      url: 'http://flaky-server:9099/webhook',
      secret: 'whsec_payments',
      status: 'active',
    },
  ];

  for (const d of destinations) {
    // Idempotent insert: skip if already exists
    await pool.query(
      `INSERT INTO destinations (id, owner_id, url, secret, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.owner_id, d.url, d.secret, d.status]
    );
    log.info({ destination_id: d.id }, 'seed: destination ensured');
  }

  // ── Sample events per destination ───────────────────────────
  const eventPayloads = [
    { event_type: 'order.created', payload: { order_id: 1001, total: 49.99, currency: 'USD' } },
    { event_type: 'order.updated', payload: { order_id: 1001, status: 'shipped' } },
    { event_type: 'payment.succeeded', payload: { payment_id: 'py_abc123', amount: 49.99 } },
    { event_type: 'user.created', payload: { user_id: 'usr_001', email: 'alice@example.com' } },
    { event_type: 'user.updated', payload: { user_id: 'usr_001', role: 'admin' } },
  ];

  for (const destId of ['acme-orders', 'payments-stripe']) {
    for (let i = 0; i < 3; i++) {
      const evData = eventPayloads[i % eventPayloads.length];
      const event = await eventRepo.insert({
        id: uuidv4(),
        destination_id: destId,
        event_type: evData.event_type,
        payload: evData.payload,
        idempotency_key: `${destId}-${i}`,
      });

      // Create a delivery attempt for each event
      // Odd indices get a failure with a scheduled retry
      const willFail = i % 2 === 1;
      const attempt = await attemptRepo.insert({
        event_id: event.id,
        attempt_number: 1,
        status: willFail ? 'failed' : 'success',
        http_status_code: willFail ? 500 : 200,
        response_body_snippet: willFail
          ? '{"error":"internal_error"}'
          : '{"status":"ok"}',
        next_retry_at: willFail
          ? new Date(Date.now() + 60_000).toISOString()  // retry in 1 min
          : null,
      });

      log.info({
        event_id: event.id,
        destination_id: destId,
        status: attempt.status,
        attempt: 1,
      }, 'seed: event + attempt created');
    }
  }

  await closePool();
  log.info('Seed complete.');
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
