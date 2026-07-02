import express from 'express';
import { createLogger } from '@relay/lib/logger.js';
import { config } from '@relay/lib/config.js';

const log = createLogger({ service: 'flaky-server' });
const app = express();

app.use(express.json());

let requestCount = 0;

/**
 * Simulates an unreliable webhook endpoint.
 *
 * Behaviour controlled by env vars:
 *   FLAKY_EVERY      — succeed every Nth request (default 3)
 *   FLAKY_LATENCY    — artificial delay in ms before responding
 *   FLAKY_FAIL_STATUS — HTTP status returned for "failure" responses
 */
app.post('/webhook', (_req, res) => {
  requestCount++;

  const delayMs = config.FLAKY_LATENCY;

  setTimeout(() => {
    if (requestCount % config.FLAKY_EVERY === 0) {
      log.info({ request: requestCount }, 'flaky: success');
      res.status(200).json({ status: 'ok', received: true });
    } else {
      log.info({ request: requestCount, status: config.FLAKY_FAIL_STATUS }, 'flaky: failure');
      res.status(config.FLAKY_FAIL_STATUS).json({
        error: 'simulated_failure',
        message: `Request ${requestCount} was deliberately failed`,
      });
    }
  }, delayMs);
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'flaky-endpoint-test-server',
    status: 'healthy',
    requests_served: requestCount,
    config: {
      succeed_every_n: config.FLAKY_EVERY,
      latency_ms: config.FLAKY_LATENCY,
      fail_status: config.FLAKY_FAIL_STATUS,
    },
  });
});

const server = app.listen(config.FLAKY_PORT, () => {
  log.info({ port: config.FLAKY_PORT, every: config.FLAKY_EVERY, latency: config.FLAKY_LATENCY }, 'flaky server started');
});

const shutdown = () => {
  log.info('shutting down');
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
