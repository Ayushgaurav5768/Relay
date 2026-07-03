import express from 'express';
import { createLogger } from '@relay/lib/logger.js';
import { config } from '@relay/lib/config.js';
import { checkDb, closePool } from '@relay/lib/db.js';
import { checkRedis, closeRedis } from '@relay/lib/redis.js';
import { checkRabbitMQ, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import { startConsumers, stopConsumers } from './consumer.js';

const log = createLogger({ service: 'delivery-worker' });
const app = express();

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

const server = app.listen(config.DELIVERY_WORKER_PORT, () => {
  log.info({ port: config.DELIVERY_WORKER_PORT }, 'delivery-worker started');
  startConsumers().catch((err) => {
    log.error({ err }, 'failed to start consumers');
  });
});

const shutdown = async () => {
  log.info('shutting down');
  await stopConsumers();
  server.close();
  await Promise.all([closePool(), closeRedis(), closeRabbitMQ()]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
