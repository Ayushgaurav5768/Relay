import { connectRabbitMQ, EXCHANGE_NAME } from '@relay/lib/rabbitmq.js';
import { DestinationRepository } from '@relay/lib/repositories/DestinationRepository.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';
import { config } from '@relay/lib/config.js';
import { createLogger } from '@relay/lib/logger.js';
import { deliver } from './deliver.js';

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
 */

const log = createLogger({ service: 'delivery-worker' });
const CONCURRENCY = config.DELIVERY_CONCURRENCY;

let consumers = [];
let consuming = false;

export async function startConsumers() {
  if (consuming) return;
  consuming = true;

  const channel = await connectRabbitMQ();
  const destRepo = new DestinationRepository();
  const destinations = await destRepo.findEnabled();

  if (destinations.length === 0) {
    log.warn('no active destinations found, nothing to consume');
    consuming = false;
    return;
  }

  log.info({ count: destinations.length, concurrency: CONCURRENCY }, 'starting consumers');

  for (const dest of destinations) {
    await channel.assertQueue(dest.id, { durable: true });
    await channel.bindQueue(dest.id, EXCHANGE_NAME, dest.id);
    channel.prefetch(CONCURRENCY, false);

    const { consumerTag } = await channel.consume(
      dest.id,
      (msg) => {
        if (!msg) return;
        handleMessage(dest, msg, channel);
      },
      { noAck: false }
    );

    consumers.push({ destinationId: dest.id, consumerTag });
    log.info({ destination_id: dest.id }, 'consumer started');
  }
}

export async function stopConsumers() {
  if (!consuming) return;
  consuming = false;

  const channel = await connectRabbitMQ();
  for (const { consumerTag } of consumers) {
    try {
      await channel.cancel(consumerTag);
    } catch (err) {
      log.warn({ err, consumerTag }, 'error cancelling consumer');
    }
  }
  consumers = [];
  log.info('all consumers stopped');
}

export function __test__resetConsumersState() {
  consuming = false;
  consumers = [];
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

  const attemptRepo = new DeliveryAttemptRepository();
  let statusCode = null;
  let snippet = null;
  let deliveryStatus = 'failed';

  try {
    const result = await deliver(dest, body);
    statusCode = result.statusCode;
    snippet = result.responseBodySnippet;

    if (statusCode >= 200 && statusCode < 300) {
      deliveryStatus = 'success';
      log.info({ event_id: eventId, statusCode }, 'delivery succeeded');
    } else {
      log.warn({ event_id: eventId, statusCode, snippet }, 'delivery returned non-2xx');
    }
  } catch (err) {
    log.error({ err, event_id: eventId, destination_id: dest.id }, 'delivery failed with network error');
  }

  try {
    await attemptRepo.insert({
      event_id: eventId,
      attempt_number: 1,
      status: deliveryStatus,
      http_status_code: statusCode,
      response_body_snippet: snippet,
      next_retry_at: null,
    });
  } catch (err) {
    log.error({ err, event_id: eventId }, 'failed to persist delivery attempt');
  }

  channel.ack(msg);
}
