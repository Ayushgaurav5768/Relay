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
 * Path-based behaviour:
 *   /webhook       — flaky: succeed every Nth request (controlled by FLAKY_EVERY)
 *   /succeed       — always returns HTTP 200
 *   /fail          — always returns HTTP 500
 *
 * Global env vars:
 *   FLAKY_EVERY      — succeed every Nth request on /webhook (default 3).
 *   FLAKY_FAIL_COUNT — fail the first N requests on /webhook, then succeed.
 *                      When set, this overrides FLAKY_EVERY.
 *   FLAKY_LATENCY    — artificial delay in ms before responding
 *   FLAKY_FAIL_STATUS — HTTP status returned for "failure" responses
 */
function respond(res, status, body) {
  const delayMs = config.FLAKY_LATENCY;
  if (delayMs > 0) {
    setTimeout(() => res.status(status).json(body), delayMs);
  } else {
    res.status(status).json(body);
  }
}

app.post('/succeed', (_req, res) => {
  requestCount++;
  log.info({ request: requestCount }, 'succeed: always ok');
  respond(res, 200, { status: 'ok', received: true });
});

app.post('/fail', (_req, res) => {
  requestCount++;
  log.info({ request: requestCount }, 'fail: always failing');
  respond(res, config.FLAKY_FAIL_STATUS, {
    error: 'simulated_failure',
    message: 'Always-fail endpoint',
  });
});

app.post('/webhook', (_req, res) => {
  requestCount++;

  const failCount = config.FLAKY_FAIL_COUNT;
  const isSuccess = failCount > 0
    ? requestCount > failCount
    : requestCount % config.FLAKY_EVERY === 0;

  if (isSuccess) {
    log.info({ request: requestCount }, 'flaky: success');
    respond(res, 200, { status: 'ok', received: true });
  } else {
    log.info({ request: requestCount, status: config.FLAKY_FAIL_STATUS }, 'flaky: failure');
    respond(res, config.FLAKY_FAIL_STATUS, {
      error: 'simulated_failure',
      message: `Request ${requestCount} was deliberately failed`,
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'flaky-endpoint-test-server',
    status: 'healthy',
    requests_served: requestCount,
    config: {
      fail_count: config.FLAKY_FAIL_COUNT,
      succeed_every_n: config.FLAKY_EVERY,
      latency_ms: config.FLAKY_LATENCY,
      fail_status: config.FLAKY_FAIL_STATUS,
    },
  });
});

const server = app.listen(config.FLAKY_PORT, () => {
  log.info({
    port: config.FLAKY_PORT,
    failCount: config.FLAKY_FAIL_COUNT,
    every: config.FLAKY_EVERY,
    latency: config.FLAKY_LATENCY,
  }, 'flaky server started');
});

const shutdown = () => {
  log.info('shutting down');
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
