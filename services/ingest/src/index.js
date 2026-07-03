import express from 'express';
import { createLogger } from '@relay/lib/logger.js';
import { config } from '@relay/lib/config.js';
import { checkDb, closePool } from '@relay/lib/db.js';
import { checkRedis, closeRedis } from '@relay/lib/redis.js';
import { checkRabbitMQ, closeRabbitMQ } from '@relay/lib/rabbitmq.js';
import eventsRouter from './events.js';
import { startOutboxPublisher, stopOutboxPublisher } from './outboxPublisher.js';

const log = createLogger({ service: 'ingest' });
const app = express();

app.use(express.json());

app.get('/health', async (_req, res) => {
  const [db, redis, rmq] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkRabbitMQ(),
  ]);

  const allOk = db.ok && redis.ok && rmq.ok;

  res.status(allOk ? 200 : 503).json({
    service: 'ingest',
    status: allOk ? 'healthy' : 'degraded',
    postgres: db,
    redis,
    rabbitmq: rmq,
  });
});

app.use(eventsRouter);

const server = app.listen(config.INGEST_PORT, () => {
  log.info({ port: config.INGEST_PORT }, 'ingest service started');
  startOutboxPublisher();
});

const shutdown = async () => {
  log.info('shutting down');
  stopOutboxPublisher();
  server.close();
  await Promise.all([closePool(), closeRedis(), closeRabbitMQ()]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
