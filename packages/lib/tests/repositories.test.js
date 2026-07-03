import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../src/db.js', () => ({
  query: mockQuery,
}));

const { EventRepository } = await import('../src/repositories/EventRepository.js');
const { OutboxRepository } = await import('../src/repositories/OutboxRepository.js');
const { DestinationRepository } = await import('../src/repositories/DestinationRepository.js');
const { DeliveryAttemptRepository } = await import('../src/repositories/DeliveryAttemptRepository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// EventRepository
// ===========================================================================
describe('EventRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new EventRepository();
  });

  describe('insert', () => {
    const data = {
      id: 'evt-001',
      destination_id: 'dest-a',
      event_type: 'order.created',
      payload: { order_id: 1 },
      idempotency_key: 'key-1',
    };

    it('inserts an event with all fields', async () => {
      const fakeRow = { id: 'evt-001', destination_id: 'dest-a', event_type: 'order.created', payload: { order_id: 1 }, idempotency_key: 'key-1', status: 'pending', created_at: new Date() };
      mockQuery.mockResolvedValue({ rows: [fakeRow] });

      const result = await repo.insert(data);

      expect(mockQuery).toHaveBeenCalledOnce();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO events'),
        [data.id, data.destination_id, data.event_type, expect.any(String), data.idempotency_key]
      );
      expect(result).toEqual(fakeRow);
    });

    it('inserts without idempotency_key', async () => {
      const { idempotency_key: _, ...noKey } = data;
      mockQuery.mockResolvedValue({ rows: [{ id: 'evt-002' }] });

      await repo.insert(noKey);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [noKey.id, noKey.destination_id, noKey.event_type, expect.any(String), null]
      );
    });

    it('uses client.query when a transaction client is provided', async () => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'evt-tx' }] });
      const client = { query: clientQuery };

      const result = await repo.insert(data, client);

      expect(clientQuery).toHaveBeenCalledOnce();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(result.id).toBe('evt-tx');
    });

    it('re-throws database errors', async () => {
      mockQuery.mockRejectedValue(new Error('connection lost'));

      await expect(repo.insert(data)).rejects.toThrow('connection lost');
    });
  });

  describe('findById', () => {
    it('returns event when found', async () => {
      const fake = { id: 'evt-001' };
      mockQuery.mockResolvedValue({ rows: [fake] });

      const result = await repo.findById('evt-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM events'),
        ['evt-001']
      );
      expect(result).toEqual(fake);
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByIdempotencyKey', () => {
    it('queries by destination and key', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'evt-001' }] });

      const result = await repo.findByIdempotencyKey('dest-a', 'key-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('destination_id'),
        ['dest-a', 'key-1']
      );
      expect(result.id).toBe('evt-001');
    });

    it('returns null on miss', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repo.findByIdempotencyKey('dest-a', 'no-match');

      expect(result).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('updates status and returns event', async () => {
      const fake = { id: 'evt-001', status: 'delivered' };
      mockQuery.mockResolvedValue({ rows: [fake] });

      const result = await repo.updateStatus('evt-001', 'delivered');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE events SET status'),
        ['evt-001', 'delivered']
      );
      expect(result.status).toBe('delivered');
    });

    it('uses client.query in transaction', async () => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'evt-001', status: 'dead' }] });
      const client = { query: clientQuery };

      const result = await repo.updateStatus('evt-001', 'dead', client);

      expect(clientQuery).toHaveBeenCalledOnce();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(result.status).toBe('dead');
    });
  });

  describe('list', () => {
    it('returns paginated results without filters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })  // COUNT
        .mockResolvedValueOnce({ rows: [{ id: 'e1' }, { id: 'e2' }] }); // SELECT

      const result = await repo.list({ limit: 2, offset: 0 });

      expect(result.total).toBe(5);
      expect(result.rows).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('filters by destination_id when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1' }] });

      await repo.list({ destination_id: 'dest-a', limit: 10, offset: 0 });

      expect(mockQuery.mock.calls[0][1]).toContain('dest-a');
      expect(mockQuery.mock.calls[1][1]).toContain('dest-a');
    });
  });

  describe('listWithAttemptCounts', () => {
    it('returns events with attempt_count', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1', attempt_count: 3 }] });

      const result = await repo.listWithAttemptCounts({ page: 1, limit: 10 });

      expect(result.total).toBe(10);
      expect(result.rows[0].attempt_count).toBe(3);
    });

    it('filters by status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1' }, { id: 'e2' }] });

      await repo.listWithAttemptCounts({ status: 'delivered', page: 1, limit: 10 });

      expect(mockQuery.mock.calls[0][1]).toContain('delivered');
      expect(mockQuery.mock.calls[1][1]).toContain('delivered');
    });
  });
});

// ===========================================================================
// OutboxRepository
// ===========================================================================
describe('OutboxRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new OutboxRepository();
  });

  describe('insert', () => {
    const data = {
      event_id: 'evt-001',
      destination_id: 'dest-a',
      routing_key: 'dest-a',
      payload: { hello: 'world' },
    };

    it('inserts an outbox row', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'ob-001', ...data }] });

      const result = await repo.insert(data);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO outbox'),
        [data.event_id, data.destination_id, data.routing_key, expect.any(String)]
      );
      expect(result.id).toBe('ob-001');
    });

    it('uses client.query in transaction', async () => {
      const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'ob-tx' }] });
      const client = { query: clientQuery };

      const result = await repo.insert(data, client);

      expect(clientQuery).toHaveBeenCalledOnce();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(result.id).toBe('ob-tx');
    });
  });

  describe('claimUnpublished', () => {
    it('returns unpublished records ordered by created_at', async () => {
      const rows = [{ id: 'ob-1' }, { id: 'ob-2' }];
      mockQuery.mockResolvedValue({ rows });

      const result = await repo.claimUnpublished(10);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE published = false'),
        [10]
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('markPublished', () => {
    it('sets published flag and timestamp', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.markPublished('ob-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE outbox SET published = true'),
        ['ob-001']
      );
    });
  });
});

// ===========================================================================
// DestinationRepository
// ===========================================================================
describe('DestinationRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new DestinationRepository();
  });

  describe('findById', () => {
    it('returns destination when found', async () => {
      const fake = { id: 'dest-a', url: 'http://example.com', secret: 'shh' };
      mockQuery.mockResolvedValue({ rows: [fake] });

      const result = await repo.findById('dest-a');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM destinations'),
        ['dest-a']
      );
      expect(result).toEqual(fake);
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns all destinations', async () => {
      const rows = [{ id: 'a' }, { id: 'b' }];
      mockQuery.mockResolvedValue({ rows });

      const result = await repo.findAll();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM destinations ORDER BY id')
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('findEnabled', () => {
    it('returns only active destinations', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'a', status: 'active' }] });

      const result = await repo.findEnabled();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status = 'active'")
      );
      expect(result).toHaveLength(1);
    });
  });
});

// ===========================================================================
// DeliveryAttemptRepository
// ===========================================================================
describe('DeliveryAttemptRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new DeliveryAttemptRepository();
  });

  describe('insert', () => {
    const data = {
      event_id: 'evt-001',
      attempt_number: 1,
      status: 'success',
      http_status_code: 200,
      response_body_snippet: '{"ok":true}',
      next_retry_at: null,
    };

    it('inserts a delivery attempt', async () => {
      const fake = { id: 'da-001', ...data };
      mockQuery.mockResolvedValue({ rows: [fake] });

      const result = await repo.insert(data);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO delivery_attempts'),
        [data.event_id, data.attempt_number, data.status, data.http_status_code, data.response_body_snippet, data.next_retry_at]
      );
      expect(result).toEqual(fake);
    });

    it('inserts attempt with failed status and retry date', async () => {
      const failed = { ...data, status: 'failed', next_retry_at: '2026-01-01T00:00:00Z' };
      mockQuery.mockResolvedValue({ rows: [{ id: 'da-002' }] });

      await repo.insert(failed);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [failed.event_id, failed.attempt_number, 'failed', failed.http_status_code, failed.response_body_snippet, '2026-01-01T00:00:00Z']
      );
    });
  });

  describe('markSuccess', () => {
    it('sets status to success and clears retry', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.markSuccess('da-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'success'"),
        ['da-001']
      );
    });
  });

  describe('markFailed', () => {
    it('sets status to failed with retry date', async () => {
      const retryAt = '2026-01-01T00:01:00Z';
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.markFailed('da-001', retryAt);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'failed'"),
        ['da-001', retryAt]
      );
    });
  });

  describe('findByEventId', () => {
    it('returns attempts ordered by attempt_number', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'da-1', attempt_number: 1 }, { id: 'da-2', attempt_number: 2 }] });

      const result = await repo.findByEventId('evt-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY attempt_number ASC'),
        ['evt-001']
      );
      expect(result).toHaveLength(2);
    });

    it('returns empty array when no attempts exist', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repo.findByEventId('evt-none');

      expect(result).toEqual([]);
    });
  });

  describe('findLatestByEventId', () => {
    it('returns the most recent attempt', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'da-2', attempt_number: 2 }] });

      const result = await repo.findLatestByEventId('evt-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY attempt_number DESC'),
        ['evt-001']
      );
      expect(result.attempt_number).toBe(2);
    });

    it('returns null when no attempts', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repo.findLatestByEventId('evt-none');

      expect(result).toBeNull();
    });
  });

  describe('countByEventId', () => {
    it('returns the count of attempts', async () => {
      mockQuery.mockResolvedValue({ rows: [{ count: 3 }] });

      const result = await repo.countByEventId('evt-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT COUNT(*)'),
        ['evt-001']
      );
      expect(result).toBe(3);
    });
  });

  describe('claimDueRetries', () => {
    it('claims due retries with FOR UPDATE SKIP LOCKED', async () => {
      const rows = [{ id: 'da-1', event_id: 'evt-001' }];
      mockQuery.mockResolvedValue({ rows });

      const result = await repo.claimDueRetries('worker-1', 10);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE SKIP LOCKED'),
        [10]
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('deleteByEventId', () => {
    it('deletes all attempts for an event', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.deleteByEventId('evt-001');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM delivery_attempts'),
        ['evt-001']
      );
    });
  });
});
