import express from 'express';
import { createLogger } from '@relay/lib/logger.js';
import { config } from '@relay/lib/config.js';
import { checkDb, closePool } from '@relay/lib/db.js';
import { checkRedis, closeRedis } from '@relay/lib/redis.js';
import { metricsHandler } from '@relay/lib/metrics.js';

const log = createLogger({ service: 'dashboard-api' });
const app = express();

app.get('/metrics', metricsHandler);

app.get('/health', async (_req, res) => {
  const [db, redis] = await Promise.all([
    checkDb(),
    checkRedis(),
  ]);

  const allOk = db.ok && redis.ok;

  res.status(allOk ? 200 : 503).json({
    service: 'dashboard-api',
    status: allOk ? 'healthy' : 'degraded',
    postgres: db,
    redis,
  });
});

const server = app.listen(config.DASHBOARD_PORT, () => {
  log.info({ port: config.DASHBOARD_PORT }, 'dashboard-api started');
});

const shutdown = async () => {
  log.info('shutting down');
  server.close();
  await Promise.all([closePool(), closeRedis()]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
