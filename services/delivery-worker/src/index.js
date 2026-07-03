import express from 'express';
import { createLogger } from '@relay/lib/logger.js';
import { config } from '@relay/lib/config.js';
import { checkDb, closePool } from '@relay/lib/db.js';
import { getRedis, checkRedis, closeRedis } from '@relay/lib/redis.js';
import { checkRabbitMQ, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { metricsHandler, circuitBreakerState } from '@relay/lib/metrics.js';
import { startConsumers, stopConsumers, startQueueDepthCollector } from './consumer.js';
import { startRetryWorker, stopRetryWorker } from './retryWorker.js';

const log = createLogger({ service: 'delivery-worker' });
const app = express();

app.get('/metrics', metricsHandler);

app.get('/health', async (_req, res) => {
  const [db, redis, rmq] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkRabbitMQ(),
  ]);

  const allOk = db.ok && redis.ok && rmq.ok;

  res.status(allOk ? 200 : 503).json({
    service: 'delivery-worker',
    status: allOk ? 'healthy' : 'degraded',
    postgres: db,
    redis,
    rabbitmq: rmq,
    max_retries: config.MAX_RETRIES,
    cb_failure_threshold: config.CB_FAILURE_THRESHOLD,
  });
});

const CB_COLLECT_INTERVAL_MS = 10000;
let cbCollectTimer = null;

function startCbStateCollector() {
  async function collect() {
    try {
      const redis = getRedis();
      const keys = await redis.keys('cb:*');
      circuitBreakerState.reset();
      for (const key of keys) {
        const destId = key.replace('cb:', '');
        const data = await redis.hgetall(key);
        if (data && data.state) {
          circuitBreakerState.set({ destination_id: destId, state: data.state }, 1);
        }
      }
    } catch (err) {
      log.warn({ err }, 'cb state metric collection failed');
    }
  }
  collect();
  cbCollectTimer = setInterval(collect, CB_COLLECT_INTERVAL_MS);
}

function stopCbStateCollector() {
  if (cbCollectTimer) {
    clearInterval(cbCollectTimer);
    cbCollectTimer = null;
  }
}

const server = app.listen(config.DELIVERY_WORKER_PORT, () => {
  log.info({ port: config.DELIVERY_WORKER_PORT }, 'delivery-worker started');
  startConsumers().then(() => {
    startQueueDepthCollector();
  }).catch((err) => {
    log.error({ err }, 'failed to start consumers');
  });
  startRetryWorker();
  startCbStateCollector();
});

const shutdown = async () => {
  log.info('shutting down');
  stopRetryWorker();
  stopCbStateCollector();
  await stopConsumers();
  server.close();
  await Promise.all([closePool(), closeRedis(), closeRabbitMQ()]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
