import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockDestRepo = {
  findById: vi.fn(),
  findAll: vi.fn(),
};

const mockEventRepo = {
  insert: vi.fn(),
  findById: vi.fn(),
  findByIdempotencyKey: vi.fn(),
  updateStatus: vi.fn(),
  listWithAttemptCounts: vi.fn(),
};

const mockOutboxRepo = {
  insert: vi.fn(),
};

const mockAttemptRepo = {
  findByEventId: vi.fn(),
  deleteByEventId: vi.fn(),
};

const mockRedisEval = vi.fn();
const mockPipelineExec = vi.fn();

vi.mock('@relay/lib/repositories/DestinationRepository.js', () => ({
  DestinationRepository: vi.fn().mockImplementation(() => mockDestRepo),
}));

vi.mock('@relay/lib/repositories/EventRepository.js', () => ({
  EventRepository: vi.fn().mockImplementation(() => mockEventRepo),
}));

vi.mock('@relay/lib/repositories/OutboxRepository.js', () => ({
  OutboxRepository: vi.fn().mockImplementation(() => mockOutboxRepo),
}));

vi.mock('@relay/lib/repositories/DeliveryAttemptRepository.js', () => ({
  DeliveryAttemptRepository: vi.fn().mockImplementation(() => mockAttemptRepo),
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
    pipeline: vi.fn(() => ({
      hgetall: vi.fn(),
      exec: mockPipelineExec,
    })),
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

/* ──────────────────────────────────────────────
 * POST /events
 * ────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────
 * GET /events/:id
 * ────────────────────────────────────────────── */
describe('GET /events/:id', () => {
  it('returns 200 with event and attempts when found', async () => {
    const app = createApp();
    const eventData = {
      id: 'evt-123',
      destination_id: 'acme-orders',
      event_type: 'order.created',
      payload: { order_id: 1001 },
      idempotency_key: null,
      created_at: '2025-06-01T12:00:00Z',
    };
    const attemptsData = [
      {
        id: 'att-1',
        event_id: 'evt-123',
        attempt_number: 1,
        status: 'failed',
        http_status_code: 500,
        response_body_snippet: 'Internal Server Error',
        attempted_at: '2025-06-01T12:00:10Z',
        next_retry_at: '2025-06-01T12:02:00Z',
      },
    ];
    mockEventRepo.findById.mockResolvedValue(eventData);
    mockAttemptRepo.findByEventId.mockResolvedValue(attemptsData);

    const res = await request(app)
      .get('/events/evt-123')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject(eventData);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject(attemptsData[0]);
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

/* ──────────────────────────────────────────────
 * GET /events (paginated list)
 * ────────────────────────────────────────────── */
describe('GET /events', () => {
  it('returns paginated events with attempt counts and default page/limit', async () => {
    const app = createApp();
    const events = [
      { id: 'evt-2', destination_id: 'acme-orders', status: 'delivered', attempt_count: 1, created_at: '2025-06-02T12:00:00Z' },
      { id: 'evt-1', destination_id: 'acme-orders', status: 'failed', attempt_count: 5, created_at: '2025-06-01T12:00:00Z' },
    ];
    mockEventRepo.listWithAttemptCounts.mockResolvedValue({ rows: events, total: 2 });

    const res = await request(app)
      .get('/events')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.total_pages).toBe(1);
    expect(mockEventRepo.listWithAttemptCounts).toHaveBeenCalledWith({
      destination_id: undefined,
      status: undefined,
      page: 1,
      limit: 50,
    });
  });

  it('filters by destination_id and status', async () => {
    const app = createApp();
    mockEventRepo.listWithAttemptCounts.mockResolvedValue({ rows: [], total: 0 });

    const res = await request(app)
      .get('/events?destination_id=acme-orders&status=failed')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockEventRepo.listWithAttemptCounts).toHaveBeenCalledWith({
      destination_id: 'acme-orders',
      status: 'failed',
      page: 1,
      limit: 50,
    });
  });

  it('respects page and limit query params', async () => {
    const app = createApp();
    const events = [{ id: 'evt-3', destination_id: 'acme-orders', status: 'pending', attempt_count: 0, created_at: '2025-06-03T12:00:00Z' }];
    mockEventRepo.listWithAttemptCounts.mockResolvedValue({ rows: events, total: 25 });

    const res = await request(app)
      .get('/events?page=3&limit=10')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.page).toBe(3);
    expect(res.body.limit).toBe(10);
    expect(res.body.total).toBe(25);
    expect(res.body.total_pages).toBe(3);
    expect(mockEventRepo.listWithAttemptCounts).toHaveBeenCalledWith({
      destination_id: undefined,
      status: undefined,
      page: 3,
      limit: 10,
    });
  });

  it('clamps limit to max 100 and min 1', async () => {
    const app = createApp();
    mockEventRepo.listWithAttemptCounts.mockResolvedValue({ rows: [], total: 0 });

    const res = await request(app)
      .get('/events?limit=999')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(mockEventRepo.listWithAttemptCounts).toHaveBeenCalledWith({
      destination_id: undefined,
      status: undefined,
      page: 1,
      limit: 100,
    });
  });

  it('returns empty list when no events match', async () => {
    const app = createApp();
    mockEventRepo.listWithAttemptCounts.mockResolvedValue({ rows: [], total: 0 });

    const res = await request(app)
      .get('/events?destination_id=nonexistent')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.total_pages).toBe(1);
  });
});

/* ──────────────────────────────────────────────
 * GET /destinations
 * ────────────────────────────────────────────── */
describe('GET /destinations', () => {
  const mockDestinations = [
    { id: 'acme-orders', owner_id: 'org_acme', url: 'http://example.com/webhook', secret: 's3cret', status: 'active', created_at: '2025-01-01T00:00:00Z' },
    { id: 'acme-shipments', owner_id: 'org_acme', url: 'http://example.com/ship', secret: null, status: 'active', created_at: '2025-01-02T00:00:00Z' },
  ];

  it('returns destinations without secret and with health from CB', async () => {
    const app = createApp();
    mockDestRepo.findAll.mockResolvedValue(mockDestinations);
    mockPipelineExec.mockResolvedValue([
      [null, { state: 'CLOSED', failure_count: '0' }],
      [null, { state: 'OPEN', failure_count: '5', cooldown_until: String(Date.now() + 30000) }],
    ]);

    const res = await request(app)
      .get('/destinations')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.destinations).toHaveLength(2);

    const d1 = res.body.destinations[0];
    expect(d1.id).toBe('acme-orders');
    expect(d1.secret).toBeUndefined();
    expect(d1.health).toBe('healthy');

    const d2 = res.body.destinations[1];
    expect(d2.id).toBe('acme-shipments');
    expect(d2.secret).toBeUndefined();
    expect(d2.health).toBe('unhealthy');
  });

  it('marks half-open as degraded', async () => {
    const app = createApp();
    mockDestRepo.findAll.mockResolvedValue(mockDestinations);
    mockPipelineExec.mockResolvedValue([
      [null, { state: 'HALF_OPEN', failure_count: '3' }],
      [null, {}],
    ]);

    const res = await request(app)
      .get('/destinations')
      .set('Authorization', AUTH_HEADER);

    expect(res.body.destinations[0].health).toBe('degraded');
    expect(res.body.destinations[1].health).toBe('healthy');
  });

  it('marks health unknown when Redis call fails', async () => {
    const app = createApp();
    mockDestRepo.findAll.mockResolvedValue(mockDestinations);
    mockPipelineExec.mockRejectedValue(new Error('Redis connection lost'));

    const res = await request(app)
      .get('/destinations')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    res.body.destinations.forEach((d) => {
      expect(d.health).toBe('unknown');
    });
  });

  it('falls back to healthy when CB key does not exist in Redis', async () => {
    const app = createApp();
    mockDestRepo.findAll.mockResolvedValue(mockDestinations);
    mockPipelineExec.mockResolvedValue([
      [null, {}],
      [null, {}],
    ]);

    const res = await request(app)
      .get('/destinations')
      .set('Authorization', AUTH_HEADER);

    expect(res.body.destinations[0].health).toBe('healthy');
  });

  it('strips secret from all destinations', async () => {
    const app = createApp();
    mockDestRepo.findAll.mockResolvedValue(mockDestinations);
    mockPipelineExec.mockResolvedValue([
      [null, {}],
      [null, {}],
    ]);

    const res = await request(app)
      .get('/destinations')
      .set('Authorization', AUTH_HEADER);

    res.body.destinations.forEach((d) => {
      expect(d.secret).toBeUndefined();
    });
  });
});

/* ──────────────────────────────────────────────
 * POST /events/:id/replay
 * ────────────────────────────────────────────── */
describe('POST /events/:id/replay', () => {
  const deadEvent = {
    id: 'evt-dead',
    destination_id: 'acme-orders',
    event_type: 'order.created',
    payload: { order_id: 1001 },
    status: 'dead',
    created_at: '2025-06-01T12:00:00Z',
  };
  const activeDest = {
    id: 'acme-orders',
    owner_id: 'org_acme',
    url: 'http://example.com/webhook',
    secret: null,
    status: 'active',
    created_at: '2025-01-01T00:00:00Z',
  };

  it('replays a dead event and returns pending status', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(deadEvent);
    mockDestRepo.findById.mockResolvedValue(activeDest);

    const res = await request(app)
      .post('/events/evt-dead/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      event_id: 'evt-dead',
      destination_id: 'acme-orders',
      status: 'pending',
    });
    expect(mockAttemptRepo.deleteByEventId).toHaveBeenCalledWith('evt-dead');
    expect(mockEventRepo.updateStatus).toHaveBeenCalledWith('evt-dead', 'pending', expect.anything());
    expect(mockOutboxRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns 422 when event is not dead', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue({ ...deadEvent, status: 'failed' });
    mockDestRepo.findById.mockResolvedValue(activeDest);

    const res = await request(app)
      .post('/events/evt-failed/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('only dead-lettered events can be replayed');
  });

  it('returns 404 when event does not exist', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(null);

    const res = await request(app)
      .post('/events/nonexistent/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event not found');
  });

  it('returns 403 when destination belongs to another owner', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(deadEvent);
    mockDestRepo.findById.mockResolvedValue({
      ...activeDest,
      owner_id: 'other_org',
    });

    const res = await request(app)
      .post('/events/evt-dead/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('destination does not belong to this owner');
  });

  it('returns 422 when destination is not active', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(deadEvent);
    mockDestRepo.findById.mockResolvedValue({ ...activeDest, status: 'disabled' });

    const res = await request(app)
      .post('/events/evt-dead/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('destination is not active');
  });

  it('returns 500 on database error during replay', async () => {
    const app = createApp();
    mockEventRepo.findById.mockResolvedValue(deadEvent);
    mockDestRepo.findById.mockResolvedValue(activeDest);
    mockAttemptRepo.deleteByEventId.mockRejectedValue(new Error('connection lost'));

    const res = await request(app)
      .post('/events/evt-dead/replay')
      .set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });
});
