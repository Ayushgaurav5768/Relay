import { connectRabbitMQ, EXCHANGE_NAME } from '@relay/lib/rabbitmq.js';
import { DestinationRepository } from '@relay/lib/repositories/DestinationRepository.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';
import { EventRepository } from '@relay/lib/repositories/EventRepository.js';
import { config } from '@relay/lib/config.js';
import { createLogger } from '@relay/lib/logger.js';
import { getRedis } from '@relay/lib/redis.js';
import { CircuitBreaker } from '@relay/lib/circuitBreaker.js';
import { deliver } from './deliver.js';
import { computeNextRetry } from './retryScheduler.js';

/*
 * Per-destination concurrency control:
 *
 * Each active destination gets its own queue bound to the topic exchange
 * with routing key = destination_id. RMQ's per-consumer prefetch
 * (basic.qos with global=false) limits the number of unacknowledged
 * messages each destination can have in flight to DELIVERY_CONCURRENCY.
 *
 * This prevents one destination's backlog from starving others: a slow
 * destination can hold at most CONCURRENCY slots, while other
 * destinations' consumers remain fully available. Combined with separate
 * per-destination queues, worker capacity is naturally load-balanced
 * across all destinations.
 *
 * Retry strategy:
 *   Postgres next_retry_at + scheduler worker — delivery_attempts rows
 *   carry a next_retry_at timestamp. On failure, the consumer computes
 *   an exponential backoff with full jitter and writes it to the attempt
 *   row. A background retry worker (retryWorker.js) polls for due
 *   attempts and re-publishes the event to RMQ for re-delivery.
 *   Once maxRetries is exhausted, next_retry_at is set to null
 *   (terminal failure).
 *
 * Circuit breaker integration:
 *
 * RMQ does not natively support pausing an individual consumer, so we
 * implement it by cancelling the consumer for the destination and
 * scheduling a restart after the breaker cooldown expires.  Because
 * each destination has its own queue *and* its own consumer (created
 * in the loop below), calling channel.cancel(consumerTag) stops
 * message flow for that destination alone — other destinations'
 * consumers are unaffected and continue processing normally.
 *
 * Flow:
 *   1. Before delivery, isProbeAllowed() is called. If the breaker is
 *      OPEN and the cooldown is still active, the message is nacked
 *      with requeue=true as a safety net (should not happen in normal
 *      operation because the consumer is paused when OPEN).
 *   2. After delivery, the outcome is recorded via onSuccess() or
 *      onFailure(). If onFailure() transitions the breaker to OPEN,
 *      the consumer for that destination is cancelled and a restart
 *      is scheduled for (cooldown_until - now) ms later.
 *   3. When the consumer restarts, isProbeAllowed() detects the
 *      expired cooldown, auto-transitions to HALF_OPEN, and the next
 *      message serves as a probe. If it succeeds the breaker closes;
 *      if it fails the breaker re-opens with an extended cooldown.
 */

const log = createLogger({ service: 'delivery-worker' });
const CONCURRENCY = config.DELIVERY_CONCURRENCY;
const MAX_ATTEMPTS = config.MAX_ATTEMPTS;

let consumers = [];
let consuming = false;
let circuitBreakers = new Map();
let pausedDestinations = new Set();
let restartTimeouts = new Map();
let rmqChannel = null;

function createMessageHandler(dest, channel) {
  return (msg) => {
    if (!msg) return;
    handleMessage(dest, msg, channel);
  };
}

async function pauseDestinationConsumer(destId, cooldownMs) {
  if (pausedDestinations.has(destId)) return;
  pausedDestinations.add(destId);

  const entry = consumers.find(c => c.destinationId === destId);
  if (!entry || !rmqChannel) return;

  try {
    await rmqChannel.cancel(entry.consumerTag);
    log.info({ destination_id: destId, cooldown_ms: cooldownMs }, 'cb open — consumer paused');
  } catch (err) {
    log.warn({ err, destination_id: destId }, 'error pausing consumer');
  }

  const timeout = setTimeout(async () => {
    await resumeDestinationConsumer(destId);
  }, cooldownMs);

  restartTimeouts.set(destId, timeout);
}

async function resumeDestinationConsumer(destId) {
  pausedDestinations.delete(destId);
  restartTimeouts.delete(destId);

  const entry = consumers.find(c => c.destinationId === destId);
  if (!entry || !rmqChannel) return;

  try {
    const { consumerTag } = await rmqChannel.consume(
      destId,
      createMessageHandler(entry.dest, rmqChannel),
      { noAck: false }
    );
    entry.consumerTag = consumerTag;
    log.info({ destination_id: destId }, 'cb cooldown expired — consumer resumed');
  } catch (err) {
    log.error({ err, destination_id: destId }, 'error resuming consumer');
  }
}

export async function startConsumers() {
  if (consuming) return;
  consuming = true;

  rmqChannel = await connectRabbitMQ();
  const destRepo = new DestinationRepository();
  const destinations = await destRepo.findEnabled();

  if (destinations.length === 0) {
    log.warn('no active destinations found, nothing to consume');
    consuming = false;
    return;
  }

  log.info({ count: destinations.length, concurrency: CONCURRENCY }, 'starting consumers');

  try {
    const redis = getRedis();
    for (const dest of destinations) {
      circuitBreakers.set(dest.id, new CircuitBreaker(redis, dest.id));
    }
  } catch (err) {
    log.warn({ err }, 'failed to init circuit breakers, proceeding without cb');
  }

  for (const dest of destinations) {
    await rmqChannel.assertQueue(dest.id, { durable: true });
    await rmqChannel.bindQueue(dest.id, EXCHANGE_NAME, dest.id);
    rmqChannel.prefetch(CONCURRENCY, false);

    const { consumerTag } = await rmqChannel.consume(
      dest.id,
      createMessageHandler(dest, rmqChannel),
      { noAck: false }
    );

    consumers.push({ destinationId: dest.id, consumerTag, dest });
    log.info({ destination_id: dest.id }, 'consumer started');
  }
}

export async function stopConsumers() {
  if (!consuming) return;
  consuming = false;

  for (const [, timeout] of restartTimeouts) {
    clearTimeout(timeout);
  }
  restartTimeouts.clear();
  pausedDestinations.clear();

  if (rmqChannel) {
    for (const { consumerTag } of consumers) {
      try {
        await rmqChannel.cancel(consumerTag);
      } catch (err) {
        log.warn({ err, consumerTag }, 'error cancelling consumer');
      }
    }
  }
  consumers = [];
  circuitBreakers.clear();
  log.info('all consumers stopped');
}

export function __test__resetConsumersState() {
  consuming = false;
  consumers = [];
  circuitBreakers = new Map();
  pausedDestinations = new Set();
  restartTimeouts = new Map();
  rmqChannel = null;
}

async function handleMessage(dest, msg, channel) {
  let body;
  try {
    body = JSON.parse(msg.content.toString());
  } catch {
    log.warn({ destination_id: dest.id }, 'invalid JSON message, acking');
    channel.ack(msg);
    return;
  }

  const eventId = body.event_id || msg.properties.messageId || 'unknown';

  log.info({ event_id: eventId, destination_id: dest.id }, 'message received');

  // Circuit breaker — pre-flight probe check
  const cb = circuitBreakers.get(dest.id);
  if (cb) {
    try {
      const probe = await cb.isProbeAllowed();
      if (!probe.allowed) {
        log.warn({
          event_id: eventId,
          destination_id: dest.id,
          state: 'OPEN',
          retry_after_ms: probe.retry_after,
        }, 'cb open — nacking message');

        // Safety net: consumer should already be paused when OPEN, but
        // in-flight messages or race conditions may still arrive here.
        // Nack with requeue so the message waits in the queue until the
        // cooldown expires and the consumer is resumed.
        channel.nack(msg, false, true);
        return;
      }
    } catch (err) {
      log.error({ err, destination_id: dest.id }, 'cb probe check failed, proceeding with delivery (fail-open)');
    }
  }

  const attemptRepo = new DeliveryAttemptRepository();

  const latestAttempt = await attemptRepo.findLatestByEventId(eventId);
  const attemptNumber = (latestAttempt?.attempt_number || 0) + 1;

  let statusCode = null;
  let snippet = null;
  let deliveryStatus = 'failed';

  try {
    const result = await deliver(dest, body);
    statusCode = result.statusCode;
    snippet = result.responseBodySnippet;

    if (statusCode >= 200 && statusCode < 300) {
      deliveryStatus = 'success';
      log.info({ event_id: eventId, statusCode, attemptNumber }, 'delivery succeeded');
    } else {
      log.warn({ event_id: eventId, statusCode, attemptNumber, snippet }, 'delivery returned non-2xx');
    }
  } catch (err) {
    log.error({ err, event_id: eventId, destination_id: dest.id, attemptNumber }, 'delivery failed with network error');
  }

  // Circuit breaker — record outcome
  if (cb) {
    try {
      if (deliveryStatus === 'success') {
        await cb.onSuccess();
      } else {
        const cbResult = await cb.onFailure();
        if (cbResult.state === 'OPEN') {
          const cooldownMs = Math.max(0, cbResult.cooldown_until - Date.now());
          if (cooldownMs > 0) {
            await pauseDestinationConsumer(dest.id, cooldownMs);
          }
        }
      }
    } catch (err) {
      log.error({ err, destination_id: dest.id }, 'cb record failed');
    }
  }

  let nextRetryAt = null;
  if (deliveryStatus === 'failed') {
    nextRetryAt = computeNextRetry(attemptNumber, MAX_ATTEMPTS);
    if (nextRetryAt) {
      log.info({ event_id: eventId, attemptNumber, next_retry_at: nextRetryAt }, 'retry scheduled');
    } else {
      log.info({ event_id: eventId, attemptNumber }, 'max attempts exceeded, moving to DLQ');
    }
  }

  try {
    await attemptRepo.insert({
      event_id: eventId,
      attempt_number: attemptNumber,
      status: deliveryStatus,
      http_status_code: statusCode,
      response_body_snippet: snippet,
      next_retry_at: nextRetryAt,
    });
  } catch (err) {
    log.error({ err, event_id: eventId }, 'failed to persist delivery attempt');
  }

  try {
    const eventRepo = new EventRepository();
    if (deliveryStatus === 'success') {
      await eventRepo.updateStatus(eventId, 'delivered');
      log.info({ event_id: eventId }, 'event marked delivered');
    } else if (!nextRetryAt) {
      await eventRepo.updateStatus(eventId, 'dead');
      log.info({ event_id: eventId }, 'event moved to DLQ (dead)');
    } else {
      await eventRepo.updateStatus(eventId, 'failed');
    }
  } catch (err) {
    log.error({ err, event_id: eventId }, 'failed to update event status');
  }

  channel.ack(msg);
}
