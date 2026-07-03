import { connectRabbitMQ, EXCHANGE_NAME } from '@relay/lib/rabbitmq.js';
import { DeliveryAttemptRepository } from '@relay/lib/repositories/DeliveryAttemptRepository.js';
import { EventRepository } from '@relay/lib/repositories/EventRepository.js';
import { config } from '@relay/lib/config.js';
import { createLogger } from '@relay/lib/logger.js';

const log = createLogger({ service: 'retry-worker' });
const CLAIM_LIMIT = 50;

let timer = null;
let running = false;
let pollIntervalMs = config.RETRY_POLL_INTERVAL_MS;

/**
 * Start the retry scheduler worker.
 *
 * Polls delivery_attempts for rows that are due for retry
 * (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now()).
 * Claimed attempts are re-published to RabbitMQ for re-delivery.
 *
 * @param {number} [pollInterval] - Override the poll interval (ms). Defaults to config.
 */
export function startRetryWorker(pollInterval) {
  if (running) return;
  running = true;

  pollIntervalMs = pollInterval ?? config.RETRY_POLL_INTERVAL_MS;

  log.info({ pollIntervalMs }, 'retry worker started');
  poll();
}

export function stopRetryWorker() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log.info('retry worker stopped');
}

export function __test__resetRetryWorker() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function poll() {
  if (!running) return;

  try {
    const attemptRepo = new DeliveryAttemptRepository();
    const eventRepo = new EventRepository();
    const channel = await connectRabbitMQ();

    const attempts = await attemptRepo.claimDueRetries(CLAIM_LIMIT);

    if (attempts.length > 0) {
      log.info({ count: attempts.length }, 'retrying events');

      for (const attempt of attempts) {
        try {
          const event = await eventRepo.findById(attempt.event_id);
          if (!event) {
            log.warn({ event_id: attempt.event_id }, 'event not found for retry, skipping');
            continue;
          }

          const msg = {
            event_id: event.id,
            destination_id: event.destination_id,
            event_type: event.event_type,
            payload: event.payload,
          };

          channel.publish(
            EXCHANGE_NAME,
            event.destination_id,
            Buffer.from(JSON.stringify(msg)),
            { persistent: true, messageId: event.id }
          );

          log.info({ event_id: event.id, destination_id: event.destination_id, attempt_number: attempt.attempt_number }, 'retry published');
        } catch (err) {
          log.error({ err, event_id: attempt.event_id }, 'failed to publish retry');
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'retry poll cycle failed');
  }

  timer = setTimeout(poll, pollIntervalMs);
}
