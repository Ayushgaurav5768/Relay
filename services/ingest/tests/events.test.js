import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockDestRepo = {
  findById: vi.fn(),
};

const mockEventRepo = {
  insert: vi.fn(),
  findById: vi.fn(),
  findByIdempotencyKey: vi.fn(),
};

const mockOutboxRepo = {
  insert: vi.fn(),
};

const mockRedisEval = vi.fn();

vi.mock('@relay/lib/repositories/DestinationRepository.js', () => ({
  DestinationRepository: vi.fn().mockImplementation(() => mockDestRepo),
}));

vi.mock('@relay/lib/repositories/EventRepository.js', () => ({
  EventRepository: vi.fn().mockImplementation(() => mockEventRepo),
}));

vi.mock('@relay/lib/repositories/OutboxRepository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(() => mockOutboxRepo),
}));

vi.mock('@relay/lib/db.js', () => ({
  withTransaction: vi.fn((fn) => fn({ query: vi.fn() })),
  query: vi.fn(),
  getPool: vi.fn(),
  checkDb: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('@relay/lib/redis.js', () => ({
  getRedis: vi.fn(() => ({
    eval: mockRedisEval,
  })),
}));

import eventsRouter from '../src/events.js';

const API_KEY = 'dev-api-key';
const AUTH_HEADER = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(eventsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisEval.mockResolvedValue([1, 9]);
});

describe('POST /events', () => {
  const validPayload = {
    destination_id: 'acme-orders',
    event_type: 'order.created',
    payload: { order_id: 1001 },
    idempotency_key: null,
  };

  it('returns 201 and event data on valid insert', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'org_acme',
      status: 'active',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });
    mockEventRepo.insert.mockResolvedValue({
      id: 'a1b2c3d4-...',
      destination_id: 'acme-orders',
      event_type: 'order.created',
      payload: { order_id: 1001 },
      idempotency_key: null,
      created_at: '2025-06-01T12:00:00Z',
    });

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      event_id: 'a1b2c3d4-...',
      destination_id: 'acme-orders',
      event_type: 'order.created',
    });
    expect(res.body.created_at).toBeDefined();
    expect(mockOutboxRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns 200 with existing event_id on duplicate idempotency key', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'org_acme',
      status: 'active',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });
    mockEventRepo.findByIdempotencyKey.mockResolvedValue({
      id: 'existing-event-uuid',
      destination_id: 'acme-orders',
      event_type: 'order.created',
      payload: { order_id: 1001 },
      idempotency_key: 'dup-123',
      created_at: '2025-06-01T12:00:00Z',
    });

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send({ ...validPayload, idempotency_key: 'dup-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event_id: 'existing-event-uuid',
      duplicate: true,
    });
    expect(mockOutboxRepo.insert).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid payload (missing destination_id)', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send({ event_type: 'order.created', payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('returns 400 on invalid payload (non-object payload)', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send({ destination_id: 'acme-orders', event_type: 'test', payload: 'not-an-object' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation failed');
  });

  it('returns 404 when destination does not exist', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('destination not found');
  });

  it('returns 422 when destination is disabled', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'org_acme',
      status: 'disabled',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('destination is not active');
  });

  it('returns 403 when destination belongs to another owner', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'other_org',
      status: 'active',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('destination does not belong to this owner');
  });

  it('returns 500 on unexpected database error', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'org_acme',
      status: 'active',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });
    mockEventRepo.insert.mockRejectedValue(new Error('connection lost'));

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });

  it('recovers from 23505 race condition on idempotency key', async () => {
    const app = createApp();
    mockDestRepo.findById.mockResolvedValue({
      id: 'acme-orders',
      owner_id: 'org_acme',
      status: 'active',
      url: 'http://example.com/webhook',
      secret: null,
      created_at: '2025-01-01T00:00:00Z',
    });
    mockEventRepo.findByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-event-uuid',
        destination_id: 'acme-orders',
        event_type: 'order.created',
        payload: { order_id: 1001 },
        idempotency_key: 'race-dup',
        created_at: '2025-06-01T12:00:00Z',
      });
    mockEventRepo.insert.mockRejectedValue({ code: '23505', message: 'duplicate key' });

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send({ ...validPayload, idempotency_key: 'race-dup' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event_id: 'existing-event-uuid',
      duplicate: true,
    });
  });

  it('returns 401 without auth header', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/events')
      .send(validPayload);

    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid API key', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/events')
      .set('Authorization', 'Basic ' + Buffer.from('bad-key:').toString('base64'))
      .send(validPayload);

    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const app = createApp();
    mockRedisEval.mockResolvedValue([0, 0]);

    const res = await request(app)
      .post('/events')
      .set('Authorization', AUTH_HEADER)
      .send(validPayload);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate limit exceeded');
  });
});

describe('GET /events/:id', () => {
  it('returns 200 and event data when found', async () => {
    const app = createApp();
    const eventData = {
      id: 'evt-123',
      destination_id: 'acme-orders',
      event_type: 'order.created',
      payload: { order_id: 1001 },
      idempotency_key: null,
      created_at: '2025-06-01T12:00:00Z',
    };
    mockEventRepo.findById.mockResolvedValue(eventData);

    const res = await request(app)
      .get('/events/evt-123')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(eventData);
  });

  it('returns 404 when event does not exist', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .get('/events/nonexistent')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event not found');
  });
});
