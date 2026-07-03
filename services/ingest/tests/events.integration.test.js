import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closePool, query, checkDb } from '@relay/lib/db.js';
import { getRedis } from '@relay/lib/redis.js';
import { connectRabbitMQ, EXCHANGE_NAME, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { forcePublishOnce } from '../src/outboxPublisher.js';
import eventsRouter from '../src/events.js';

const DEST_ID = 'inttest-dest';
const OWNER_ID = 'org_inttest';
const API_KEY = 'dev-api-key';
const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;

let ctx = null;

async function servicesAvailable() {
  try {
    const db = await checkDb();
    if (!db.ok) return false;

    const redis = getRedis();
    await redis.ping();

    await connectRabbitMQ();

    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!(await servicesAvailable())) return;

  ctx = {};

  const pool = getPool();
  await pool.query(
    `INSERT INTO destinations (id, owner_id, url, secret, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [DEST_ID, OWNER_ID, 'http://localhost:9099/webhook', null]
  );
});

afterAll(async () => {
  if (!ctx) return;
  try {
    await query('DELETE FROM outbox WHERE destination_id = $1', [DEST_ID]);
    await query('DELETE FROM events WHERE destination_id = $1', [DEST_ID]);
    await query('DELETE FROM destinations WHERE id = $1', [DEST_ID]);
  } catch { /* best-effort cleanup */ }
  await closePool();
  await closeRabbitMQ();
});

describe('POST /events integration', { timeout: 15000 }, () => {
  it('inserts event + outbox, and message lands on RabbitMQ queue', async () => {
    if (!ctx) return;

    const channel = await connectRabbitMQ();
    const queueName = `inttest-q-${uuidv4().slice(0, 8)}`;

    try {
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE_NAME, DEST_ID);

      const app = express();
      app.use(express.json());
      app.use(eventsRouter);

      const eventType = 'order.created';
      const payload = { order_id: 9999, test: true };
      const idempotencyKey = `inttest-${uuidv4()}`;

      const res = await request(app)
        .post('/events')
        .set('Authorization', AUTH_HEADER)
        .send({
          destination_id: DEST_ID,
          event_type: eventType,
          payload,
          idempotency_key: idempotencyKey,
        });

      expect(res.status).toBe(201);
      expect(res.body.event_id).toBeDefined();

      await forcePublishOnce();

      const msg = await channel.get(queueName, { noAck: true });
      expect(msg).not.toBeNull();
      expect(msg.fields.routingKey).toBe(DEST_ID);

      const body = JSON.parse(msg.content.toString());
      expect(body.event_id).toBe(res.body.event_id);
      expect(body.destination_id).toBe(DEST_ID);
      expect(body.event_type).toBe(eventType);
      expect(body.payload).toEqual(payload);
    } finally {
      try { await channel.deleteQueue(queueName); } catch { /* ignore */ }
    }
  });

  it('returns 429 when rate limit is exceeded', async () => {
    if (!ctx) return;

    const redis = getRedis();
    const key = `ratelimit:ingest:${API_KEY}`;
    await redis.hmset(key, 'tokens', 0, 'ts', Date.now());
    await redis.pexpire(key, 5000);

    const app = express();
    app.use(express.json());
    app.use(eventsRouter);

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send({
        destination_id: DEST_ID,
        event_type: 'test',
        payload: { n: 1 },
        idempotency_key: null,
      });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate limit exceeded');

    await redis.del(key);
  });
});
