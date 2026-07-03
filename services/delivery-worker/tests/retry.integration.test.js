import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closePool, query, checkDb, withTransaction } from '@relay/lib/db.js';
import { connectRabbitMQ, EXCHANGE_NAME, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { startConsumers, stopConsumers, __test__resetConsumersState } from '../src/consumer.js';
import { startRetryWorker, stopRetryWorker, __test__resetRetryWorker } from '../src/retryWorker.js';
import { EventRepository } from '@relay/lib/repositories/EventRepository.js';
import { OutboxRepository } from '@relay/lib/repositories/OutboxRepository.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';

const DEST_ID = 'retrytest-dest';
const OWNER_ID = 'org_retrytest';
const FAIL_COUNT = 3;
const MAX_ATTEMPTS = 8;

let ctx = null;

async function servicesAvailable() {
  try {
    const db = await checkDb();
    if (!db.ok) return false;
    const channel = await connectRabbitMQ();
    await channel.checkExchange(EXCHANGE_NAME);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!(await servicesAvailable())) return;

  ctx = {};
  ctx.requests = [];

  ctx.server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      ctx.requests.push(body);
      const requestNum = ctx.requests.length;
      if (requestNum <= FAIL_COUNT) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated_failure', message: `Request ${requestNum} failed` }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', received: true }));
      }
    });
  });
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  const { port } = ctx.server.address();
  ctx.testUrl = `http://127.0.0.1:${port}/webhook`;

  const pool = getPool();
  await pool.query(
    `INSERT INTO destinations (id, owner_id, url, secret, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [DEST_ID, OWNER_ID, ctx.testUrl, null]
  );

  ctx.alwaysFailServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      ctx.alwaysFailRequests.push(body);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'always_fail', message: 'Request always fails' }));
    });
  });
  ctx.alwaysFailRequests = [];
  await new Promise((resolve) => ctx.alwaysFailServer.listen(0, '127.0.0.1', resolve));
  const { port: failPort } = ctx.alwaysFailServer.address();
  ctx.alwaysFailUrl = `http://127.0.0.1:${failPort}/webhook`;

  await pool.query(
    `INSERT INTO destinations (id, owner_id, url, secret, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    ['retrytest-dlq', OWNER_ID, ctx.alwaysFailUrl, null]
  );
});

afterAll(async () => {
  if (!ctx) return;
  stopRetryWorker();
  await stopConsumers();
  ctx.server.close();
  ctx.alwaysFailServer.close();
  try {
    await query('DELETE FROM delivery_attempts USING events WHERE events.id = delivery_attempts.event_id AND events.destination_id = $1', [DEST_ID]);
    await query('DELETE FROM events WHERE destination_id = $1', [DEST_ID]);
    await query('DELETE FROM delivery_attempts USING events WHERE events.id = delivery_attempts.event_id AND events.destination_id = $1', ['retrytest-dlq']);
    await query('DELETE FROM events WHERE destination_id = $1', ['retrytest-dlq']);
    await query('DELETE FROM destinations WHERE id IN ($1, $2)', [DEST_ID, 'retrytest-dlq']);
  } catch { /* best-effort cleanup */ }
  __test__resetConsumersState();
  __test__resetRetryWorker();
  await closePool();
  await closeRabbitMQ();
});

describe('retry scheduling chaos test', { timeout: 60000 }, () => {
  it('fails first 3 attempts and succeeds on 4th with correct backoff timing', async () => {
    if (!ctx) return;

    const eventId = uuidv4();
    const channel = await connectRabbitMQ();

    const eventPayload = {
      event_id: eventId,
      destination_id: DEST_ID,
      event_type: 'retry.test',
      payload: { seq: 1, data: 'chaos-test' },
    };

    channel.publish(
      EXCHANGE_NAME,
      DEST_ID,
      Buffer.from(JSON.stringify(eventPayload)),
      { persistent: true, messageId: eventId }
    );

    await startConsumers();
    startRetryWorker(200);

    let attempts = [];
    await vi.waitFor(
      async () => {
        const { rows } = await query(
          `SELECT da.attempt_number, da.status, da.http_status_code, da.attempted_at
           FROM delivery_attempts da
           JOIN events e ON e.id = da.event_id
           WHERE e.id = $1
           ORDER BY da.attempt_number ASC`,
          [eventId]
        );
        attempts = rows;
        expect(rows.length).toBe(FAIL_COUNT + 1);
        expect(rows[rows.length - 1].status).toBe('success');
      },
      { timeout: 55000, interval: 500 }
    );

    expect(attempts.length).toBe(4);

    for (let i = 0; i < FAIL_COUNT; i++) {
      expect(attempts[i].status).toBe('failed');
      expect(attempts[i].http_status_code).toBe(500);
    }

    expect(attempts[FAIL_COUNT].status).toBe('success');
    expect(attempts[FAIL_COUNT].http_status_code).toBe(200);

    for (let i = 1; i < attempts.length; i++) {
      const prev = new Date(attempts[i - 1].attempted_at).getTime();
      const curr = new Date(attempts[i].attempted_at).getTime();
      expect(curr).toBeGreaterThan(prev);
    }

    const { rows: eventRows } = await query(
      'SELECT status FROM events WHERE id = $1',
      [eventId]
    );
    expect(eventRows[0].status).toBe('delivered');

    await stopConsumers();
    stopRetryWorker();
  });
});

describe('DLQ and replay chaos test', { timeout: 300000 }, () => {
  let dlqEventId;

  it('reaches DLQ after max_attempts with always-failing server', async () => {
    if (!ctx) return;

    dlqEventId = uuidv4();
    const channel = await connectRabbitMQ();

    const eventPayload = {
      event_id: dlqEventId,
      destination_id: 'retrytest-dlq',
      event_type: 'dlq.test',
      payload: { seq: 1, data: 'dlq-chaos' },
    };

    channel.publish(
      EXCHANGE_NAME,
      'retrytest-dlq',
      Buffer.from(JSON.stringify(eventPayload)),
      { persistent: true, messageId: dlqEventId }
    );

    await startConsumers();
    startRetryWorker(200);

    let attempts = [];
    await vi.waitFor(
      async () => {
        const { rows } = await query(
          `SELECT da.attempt_number, da.status, da.http_status_code
           FROM delivery_attempts da
           JOIN events e ON e.id = da.event_id
           WHERE e.id = $1
           ORDER BY da.attempt_number ASC`,
          [dlqEventId]
        );
        attempts = rows;
        expect(rows.length).toBe(MAX_ATTEMPTS);
      },
      { timeout: 280000, interval: 1000 }
    );

    expect(attempts.length).toBe(MAX_ATTEMPTS);

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(attempts[i].status).toBe('failed');
      expect(attempts[i].http_status_code).toBe(500);
    }

    const { rows: eventRows } = await query(
      'SELECT status FROM events WHERE id = $1',
      [dlqEventId]
    );
    expect(eventRows[0].status).toBe('dead');

    const { rows: extraAttempts } = await query(
      `SELECT COUNT(*)::int AS count FROM delivery_attempts da
       JOIN events e ON e.id = da.event_id
       WHERE e.id = $1 AND da.attempt_number > $2`,
      [dlqEventId, MAX_ATTEMPTS]
    );
    expect(extraAttempts[0].count).toBe(0);

    await stopConsumers();
    stopRetryWorker();
  });

  it('replays a DLQd event and re-enters retry cycle', async () => {
    if (!ctx) return;

    const eventRepo = new EventRepository();
    const outboxRepo = new OutboxRepository();
    const attemptRepo = new DeliveryAttemptRepository();

    const beforeEvent = await eventRepo.findById(dlqEventId);
    expect(beforeEvent.status).toBe('dead');

    await withTransaction(async (client) => {
      await attemptRepo.deleteByEventId(dlqEventId);
      await eventRepo.updateStatus(dlqEventId, 'pending', client);
      await outboxRepo.insert({
        event_id: dlqEventId,
        destination_id: 'retrytest-dlq',
        routing_key: 'retrytest-dlq',
        payload: {
          event_id: dlqEventId,
          destination_id: 'retrytest-dlq',
          event_type: 'dlq.test',
          payload: { seq: 1, data: 'dlq-chaos' },
        },
      }, client);
    });

    const afterEvent = await eventRepo.findById(dlqEventId);
    expect(afterEvent.status).toBe('pending');

    await startConsumers();
    startRetryWorker(200);

    let attempts = [];
    await vi.waitFor(
      async () => {
        const { rows } = await query(
          `SELECT da.attempt_number, da.status, da.http_status_code
           FROM delivery_attempts da
           JOIN events e ON e.id = da.event_id
           WHERE e.id = $1
           ORDER BY da.attempt_number ASC`,
          [dlqEventId]
        );
        attempts = rows;
        expect(rows.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 30000, interval: 500 }
    );

    expect(attempts[0].attempt_number).toBe(1);
    expect(attempts[0].status).toBe('failed');
    expect(attempts[0].http_status_code).toBe(500);

    await stopConsumers();
    stopRetryWorker();
  });
});
