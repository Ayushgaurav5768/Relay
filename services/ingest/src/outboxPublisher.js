import { createLogger } from '@relay/lib/logger.js';
import { connectRabbitMQ, EXCHANGE_NAME } from '@relay/lib/rabbitmq.js';
import { OutboxRepository } from '@relay/lib/repositories/OutboxRepository.js';

const log = createLogger({ service: 'ingest' });
const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 50;

let intervalHandle = null;

export function startOutboxPublisher() {
  log.info('starting outbox publisher');
  intervalHandle = setInterval(publishBatch, POLL_INTERVAL_MS);
}

export function stopOutboxPublisher() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function forcePublishOnce() {
  await publishBatch();
}

async function publishBatch() {
  const repo = new OutboxRepository();

  try {
    const records = await repo.claimUnpublished(BATCH_SIZE);
    if (records.length === 0) return;

    log.debug({ count: records.length }, 'outbox batch claimed');

    const channel = await connectRabbitMQ();

    for (const record of records) {
      try {
        const body = Buffer.from(JSON.stringify(record.payload));
        const published = channel.publish(EXCHANGE_NAME, record.routing_key, body, {
          persistent: true,
          messageId: record.event_id,
          timestamp: Math.floor(Date.now() / 1000),
        });

        if (published) {
          await repo.markPublished(record.id);
          log.debug({ event_id: record.event_id }, 'outbox record published');
        }
      } catch (pubErr) {
        log.error({ err: pubErr, event_id: record.event_id }, 'failed to publish outbox record');
      }
    }
  } catch (err) {
    log.error({ err }, 'outbox publisher error');
  }
}
