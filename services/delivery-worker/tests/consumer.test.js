import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChannel = {
  assertQueue: vi.fn(),
  bindQueue: vi.fn(),
  prefetch: vi.fn(),
  consume: vi.fn(),
  cancel: vi.fn(),
  ack: vi.fn(),
};

const mockDestRepo = {
  findEnabled: vi.fn(),
};

const mockAttemptRepo = {
  insert: vi.fn(),
  findLatestByEventId: vi.fn(),
};

const mockEventRepo = {
  updateStatus: vi.fn(),
};

const mockDeliver = vi.fn();

vi.mock('@relay/lib/rabbitmq.js', () => ({
  connectRabbitMQ: vi.fn(() => mockChannel),
  EXCHANGE_NAME: 'relay.events',
}));

vi.mock('@relay/lib/repositories/DestinationRepository.js', () => ({
  DestinationRepository: vi.fn().mockImplementation(() => mockDestRepo),
}));

vi.mock('@relay/lib/repositories/DeliveryAttemptRepository.js', () => ({
  DeliveryAttemptRepository: vi.fn().mockImplementation(() => mockAttemptRepo),
}));

vi.mock('@relay/lib/repositories/EventRepository.js', () => ({
  EventRepository: vi.fn().mockImplementation(() => mockEventRepo),
}));

vi.mock('../src/deliver.js', () => ({
  deliver: vi.fn((...args) => mockDeliver(...args)),
}));

vi.mock('../src/retryScheduler.js', () => ({
  computeNextRetry: vi.fn(() => '2026-07-03T08:00:00.000Z'),
}));

import { startConsumers, stopConsumers, __test__resetConsumersState } from '../src/consumer.js';

beforeEach(() => {
  vi.clearAllMocks();
  __test__resetConsumersState();
});

describe('startConsumers', () => {
  it('creates one consumer per active destination', async () => {
    mockDestRepo.findEnabled.mockResolvedValue([
      { id: 'dest-a', owner_id: 'org1', url: 'http://a.com/webhook', secret: null, status: 'active' },
      { id: 'dest-b', owner_id: 'org1', url: 'http://b.com/webhook', secret: 'whsec_b', status: 'active' },
    ]);
    mockChannel.consume
      .mockResolvedValueOnce({ consumerTag: 'tag-a' })
      .mockResolvedValueOnce({ consumerTag: 'tag-b' });

    await startConsumers();

    expect(mockChannel.assertQueue).toHaveBeenCalledTimes(2);
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('dest-a', { durable: true });
    expect(mockChannel.assertQueue).toHaveBeenCalledWith('dest-b', { durable: true });

    expect(mockChannel.bindQueue).toHaveBeenCalledTimes(2);
    expect(mockChannel.bindQueue).toHaveBeenCalledWith('dest-a', 'relay.events', 'dest-a');
    expect(mockChannel.bindQueue).toHaveBeenCalledWith('dest-b', 'relay.events', 'dest-b');

    expect(mockChannel.prefetch).toHaveBeenCalledWith(5, false);
    expect(mockChannel.consume).toHaveBeenCalledTimes(2);
  });

  it('logs a warning when no active destinations exist', async () => {
    mockDestRepo.findEnabled.mockResolvedValue([]);

    await startConsumers();

    expect(mockChannel.assertQueue).not.toHaveBeenCalled();
    expect(mockChannel.consume).not.toHaveBeenCalled();
  });

  it('is idempotent — second call does nothing', async () => {
    mockDestRepo.findEnabled.mockResolvedValue([
      { id: 'dest-a', owner_id: 'org1', url: 'http://a.com/webhook', secret: null, status: 'active' },
    ]);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'tag-a' });

    await startConsumers();
    await startConsumers();

    expect(mockChannel.assertQueue).toHaveBeenCalledTimes(1);
  });
});

describe('handleMessage (via consume callback)', () => {
  const dest = { id: 'dest-a', owner_id: 'org1', url: 'http://a.com/webhook', secret: null, status: 'active' };
  const eventId = 'evt-001';
  const message = {
    event_id: eventId,
    destination_id: 'dest-a',
    event_type: 'order.created',
    payload: { order_id: 1001 },
  };

  let consumeHandler;

  function captureHandler(queue, handler) {
    consumeHandler = handler;
    return { consumerTag: 'tag-a' };
  }

  function triggerConsume(content) {
    const msg = {
      content: Buffer.from(JSON.stringify(content)),
      properties: { messageId: content.event_id },
    };
    consumeHandler(msg);
    return msg;
  }

  beforeEach(async () => {
    mockDestRepo.findEnabled.mockResolvedValue([dest]);
    mockChannel.consume.mockImplementation(captureHandler);
    mockAttemptRepo.findLatestByEventId.mockResolvedValue(null);
    await startConsumers();
  });

  it('calls deliver, inserts attempt row, updates event to delivered, and acks on success', async () => {
    mockDeliver.mockResolvedValue({ statusCode: 200, responseBodySnippet: '{"ok":true}' });

    const msg = triggerConsume(message);

    await vi.waitFor(() => {
      expect(mockDeliver).toHaveBeenCalledWith(dest, message);
    });

    expect(mockAttemptRepo.insert).toHaveBeenCalledWith({
      event_id: eventId,
      attempt_number: 1,
      status: 'success',
      http_status_code: 200,
      response_body_snippet: '{"ok":true}',
      next_retry_at: null,
    });

    await vi.waitFor(() => {
      expect(mockEventRepo.updateStatus).toHaveBeenCalledWith(eventId, 'delivered');
    });

    await vi.waitFor(() => {
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  it('inserts failed attempt with retry, updates event to failed, and acks on non-2xx response', async () => {
    mockDeliver.mockResolvedValue({ statusCode: 500, responseBodySnippet: '{"error":"internal"}' });

    const msg = triggerConsume(message);

    await vi.waitFor(() => {
      expect(mockAttemptRepo.insert).toHaveBeenCalled();
    });

    expect(mockAttemptRepo.insert).toHaveBeenCalledWith({
      event_id: eventId,
      attempt_number: 1,
      status: 'failed',
      http_status_code: 500,
      response_body_snippet: '{"error":"internal"}',
      next_retry_at: expect.any(String),
    });

    await vi.waitFor(() => {
      expect(mockEventRepo.updateStatus).toHaveBeenCalledWith(eventId, 'failed');
    });

    await vi.waitFor(() => {
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  it('inserts failed attempt with retry, updates event to failed, and acks on network error', async () => {
    mockDeliver.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const msg = triggerConsume(message);

    await vi.waitFor(() => {
      expect(mockAttemptRepo.insert).toHaveBeenCalled();
    });

    expect(mockAttemptRepo.insert).toHaveBeenCalledWith({
      event_id: eventId,
      attempt_number: 1,
      status: 'failed',
      http_status_code: null,
      response_body_snippet: null,
      next_retry_at: expect.any(String),
    });

    await vi.waitFor(() => {
      expect(mockEventRepo.updateStatus).toHaveBeenCalledWith(eventId, 'failed');
    });

    await vi.waitFor(() => {
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  it('moves event to dead status when max attempts exceeded and no retry scheduled', async () => {
    const { computeNextRetry } = await import('../src/retryScheduler.js');
    computeNextRetry.mockReturnValue(null);

    mockDeliver.mockResolvedValue({ statusCode: 500, responseBodySnippet: '{"error":"internal"}' });
    mockAttemptRepo.findLatestByEventId.mockResolvedValue({ attempt_number: 8 });

    const msg = triggerConsume(message);

    await vi.waitFor(() => {
      expect(mockAttemptRepo.insert).toHaveBeenCalled();
    });

    expect(mockAttemptRepo.insert).toHaveBeenCalledWith({
      event_id: eventId,
      attempt_number: 9,
      status: 'failed',
      http_status_code: 500,
      response_body_snippet: '{"error":"internal"}',
      next_retry_at: null,
    });

    await vi.waitFor(() => {
      expect(mockEventRepo.updateStatus).toHaveBeenCalledWith(eventId, 'dead');
    });

    await vi.waitFor(() => {
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });

  it('acks and skips processing on invalid JSON message', async () => {
    const msg = { content: Buffer.from('not-json'), properties: { messageId: null } };
    consumeHandler(msg);

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockAttemptRepo.insert).not.toHaveBeenCalled();
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
  });

  it('acks even when attempt repo insert fails', async () => {
    mockDeliver.mockResolvedValue({ statusCode: 200, responseBodySnippet: 'ok' });
    mockAttemptRepo.insert.mockRejectedValue(new Error('db error'));

    const msg = triggerConsume(message);

    await vi.waitFor(() => {
      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });
  });
});

describe('stopConsumers', () => {
  it('cancels all consumer tags', async () => {
    mockDestRepo.findEnabled.mockResolvedValue([
      { id: 'dest-a', owner_id: 'org1', url: 'http://a.com/webhook', secret: null, status: 'active' },
    ]);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'tag-a' });

    await startConsumers();
    await stopConsumers();

    expect(mockChannel.cancel).toHaveBeenCalledWith('tag-a');
  });

  it('is idempotent', async () => {
    await stopConsumers();
    expect(mockChannel.cancel).not.toHaveBeenCalled();
  });
});
