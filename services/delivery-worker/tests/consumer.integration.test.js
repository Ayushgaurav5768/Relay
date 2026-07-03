import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closePool, query, checkDb } from '@relay/lib/db.js';
import { connectRabbitMQ, EXCHANGE_NAME, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { startConsumers, stopConsumers, __test__resetConsumersState } from '../src/consumer.js';

const DEST_ID = 'ordertest-dest';
const OWNER_ID = 'org_ordertest';
const EVENT_COUNT = 5;

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
  ctx.received = [];

  ctx.server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        ctx.received.push(msg);
      } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
});

afterAll(async () => {
  if (!ctx) return;
  await stopConsumers();
  ctx.server.close();
  try {
    await query('DELETE FROM delivery_attempts USING events WHERE events.id = delivery_attempts.event_id AND events.destination_id = $1', [DEST_ID]);
    await query('DELETE FROM events WHERE destination_id = $1', [DEST_ID]);
    await query('DELETE FROM destinations WHERE id = $1', [DEST_ID]);
  } catch { /* best-effort cleanup */ }
  __test__resetConsumersState();
  await closePool();
  await closeRabbitMQ();
});

describe('per-destination ordering', { timeout: 30000 }, () => {
  it('delivers events in FIFO order with concurrency=1', async () => {
    if (!ctx) return;

    const channel = await connectRabbitMQ();
    const events = [];

    for (let i = 0; i < EVENT_COUNT; i++) {
      const ev = {
        event_id: uuidv4(),
        destination_id: DEST_ID,
        event_type: 'test.event',
        payload: { seq: i + 1, data: `event-${i + 1}` },
      };
      events.push(ev);
      channel.publish(
        EXCHANGE_NAME,
        DEST_ID,
        Buffer.from(JSON.stringify(ev)),
        { persistent: true, messageId: ev.event_id }
      );
    }

    ctx.received.length = 0;
    await startConsumers();

    await vi.waitFor(
      () => {
        expect(ctx.received.length).toBe(EVENT_COUNT);
      },
      { timeout: 15000, interval: 200 }
    );

    await stopConsumers();

    const seqs = ctx.received.map((m) => m.payload.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);

    const { rows } = await query(
      `SELECT da.status, da.http_status_code
       FROM delivery_attempts da
       JOIN events e ON e.id = da.event_id
       WHERE e.destination_id = $1
       ORDER BY e.created_at ASC`,
      [DEST_ID]
    );
    expect(rows.length).toBe(EVENT_COUNT);
    for (const row of rows) {
      expect(row.status).toBe('success');
      expect(row.http_status_code).toBe(200);
    }
  });
});
