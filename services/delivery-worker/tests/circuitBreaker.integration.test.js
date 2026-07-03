import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closePool, query, checkDb } from '@relay/lib/db.js';
import { getRedis, checkRedis } from '@relay/lib/redis.js';
import { checkRabbitMQ, connectRabbitMQ, EXCHANGE_NAME, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { CircuitBreaker } from '@relay/lib/circuitBreaker.js';
import { startConsumers, stopConsumers, __test__resetConsumersState } from '../src/consumer.js';

const DEST_A_ID = 'cbtest-a-fail';
const DEST_B_ID = 'cbtest-b-succeed';
const OWNER_ID = 'org_cbtest';
const EVENT_COUNT = 20;

let ctx = null;

async function servicesAvailable() {
  try {
    const db = await checkDb();
    if (!db.ok) return false;
    const redis = await checkRedis();
    if (!redis.ok) return false;
    const rmq = await checkRabbitMQ();
    if (!rmq.ok) return false;
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!(await servicesAvailable())) return;

  ctx = {};
  ctx.receivedA = [];
  ctx.receivedB = [];

  // Destination A — always returns 500
  ctx.serverA = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      ctx.receivedA.push(body);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'always_fail' }));
    });
  });
  await new Promise((resolve) => ctx.serverA.listen(0, '127.0.0.1', resolve));
  const urlA = `http://127.0.0.1:${ctx.serverA.address().port}/webhook`;

  // Destination B — always returns 200
  ctx.serverB = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      ctx.receivedB.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => ctx.serverB.listen(0, '127.0.0.1', resolve));
  const urlB = `http://127.0.0.1:${ctx.serverB.address().port}/webhook`;

  const pool = getPool();
  await pool.query(
    `INSERT INTO destinations (id, owner_id, url, secret, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [DEST_A_ID, OWNER_ID, urlA, null]
  );
  await pool.query(
    `INSERT INTO destinations (id, owner_id, url, secret, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [DEST_B_ID, OWNER_ID, urlB, null]
  );

  // Reset circuit breaker state from previous runs
  const redis = getRedis();
  const cbA = new CircuitBreaker(redis, DEST_A_ID);
  const cbB = new CircuitBreaker(redis, DEST_B_ID);
  await cbA.reset();
  await cbB.reset();
});

afterAll(async () => {
  if (!ctx) return;
  await stopConsumers();
  ctx.serverA.close();
  ctx.serverB.close();
  try {
    await query('DELETE FROM delivery_attempts USING events WHERE events.id = delivery_attempts.event_id AND events.destination_id = $1', [DEST_A_ID]);
    await query('DELETE FROM events WHERE destination_id = $1', [DEST_A_ID]);
    await query('DELETE FROM delivery_attempts USING events WHERE events.id = delivery_attempts.event_id AND events.destination_id = $1', [DEST_B_ID]);
    await query('DELETE FROM events WHERE destination_id = $1', [DEST_B_ID]);
    await query('DELETE FROM destinations WHERE id IN ($1, $2)', [DEST_A_ID, DEST_B_ID]);
  } catch { /* best-effort cleanup */ }
  const redis = getRedis();
  const cbA = new CircuitBreaker(redis, DEST_A_ID);
  const cbB = new CircuitBreaker(redis, DEST_B_ID);
  await cbA.reset();
  await cbB.reset();
  __test__resetConsumersState();
  await closePool();
  await closeRabbitMQ();
});

describe('CB isolation: destination A (always fail) vs B (always succeed)', { timeout: 60000 }, () => {
  it('delivers all B events successfully while A trips the circuit breaker', async () => {
    if (!ctx) return;

    const channel = await connectRabbitMQ();
    const eventsA = [];
    const eventsB = [];

    // Publish 20 events to each destination concurrently
    for (let i = 0; i < EVENT_COUNT; i++) {
      const evA = {
        event_id: uuidv4(),
        destination_id: DEST_A_ID,
        event_type: 'cb.test.a',
        payload: { seq: i + 1, dest: 'a' },
      };
      eventsA.push(evA);
      channel.publish(
        EXCHANGE_NAME,
        DEST_A_ID,
        Buffer.from(JSON.stringify(evA)),
        { persistent: true, messageId: evA.event_id }
      );

      const evB = {
        event_id: uuidv4(),
        destination_id: DEST_B_ID,
        event_type: 'cb.test.b',
        payload: { seq: i + 1, dest: 'b' },
      };
      eventsB.push(evB);
      channel.publish(
        EXCHANGE_NAME,
        DEST_B_ID,
        Buffer.from(JSON.stringify(evB)),
        { persistent: true, messageId: evB.event_id }
      );
    }

    await startConsumers();

    // Wait for all B events to be delivered successfully
    await vi.waitFor(
      async () => {
        const { rows } = await query(
          `SELECT da.status, da.http_status_code
           FROM delivery_attempts da
           JOIN events e ON e.id = da.event_id
           WHERE e.destination_id = $1 AND da.status = 'success'`,
          [DEST_B_ID]
        );
        expect(rows.length).toBe(EVENT_COUNT);
        for (const row of rows) {
          expect(row.status).toBe('success');
          expect(row.http_status_code).toBe(200);
        }
      },
      { timeout: 45000, interval: 500 }
    );

    // Verify B's circuit breaker is CLOSED with zero failures
    const redis = getRedis();
    const cbB = new CircuitBreaker(redis, DEST_B_ID, { threshold: 5, baseCooldown: 5 });
    const stateB = await cbB.getState();
    expect(stateB.state).toBe('CLOSED');
    expect(stateB.failure_count).toBe(0);

    // Verify A's circuit breaker has tripped to OPEN
    const cbA = new CircuitBreaker(redis, DEST_A_ID, { threshold: 5, baseCooldown: 5 });
    const stateA = await cbA.getState();

    // Log state for manual redis-cli inspection
    console.log('\n=== Circuit Breaker State (Destination A — always fail) ===');
    console.log(JSON.stringify(stateA, null, 2));
    console.log('=== Circuit Breaker State (Destination B — always succeed) ===');
    console.log(JSON.stringify(stateB, null, 2));
    console.log(`\nRun in another terminal to watch live:
  redis-cli HGETALL cb:${DEST_A_ID}
  redis-cli HGETALL cb:${DEST_B_ID}
`);

    expect(stateA.state).toBe('OPEN');
    expect(stateA.failure_count).toBeGreaterThanOrEqual(5);
    expect(stateA.open_count).toBeGreaterThanOrEqual(1);

    // Verify B events have normal delivery — all delivered, none in dead/failed
    const { rows: bEvents } = await query(
      `SELECT e.id, e.status
       FROM events e
       WHERE e.destination_id = $1
       ORDER BY e.created_at ASC`,
      [DEST_B_ID]
    );
    expect(bEvents.length).toBe(EVENT_COUNT);
    for (const ev of bEvents) {
      expect(ev.status).toBe('delivered');
    }

    await stopConsumers();
  });
});
