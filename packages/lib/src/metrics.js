import promClient from 'prom-client';

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

export function metricsHandler(_req, res) {
  res.set('Content-Type', register.contentType);
  register.metrics().then(data => res.end(data));
}

export const eventsIngestedTotal = new promClient.Counter({
  name: 'events_ingested_total',
  help: 'Total number of events ingested',
  labelNames: ['destination_id'],
  registers: [register],
});

export const eventsDeliveredTotal = new promClient.Counter({
  name: 'events_delivered_total',
  help: 'Total number of events delivered successfully',
  labelNames: ['destination_id'],
  registers: [register],
});

export const eventsFailedTotal = new promClient.Counter({
  name: 'events_failed_total',
  help: 'Total number of events that failed delivery',
  labelNames: ['destination_id'],
  registers: [register],
});

export const eventsDlqTotal = new promClient.Counter({
  name: 'events_dlq_total',
  help: 'Total number of events moved to dead letter queue',
  labelNames: ['destination_id'],
  registers: [register],
});

export const deliveryAttemptDurationSeconds = new promClient.Histogram({
  name: 'delivery_attempt_duration_seconds',
  help: 'Duration of delivery attempts in seconds',
  labelNames: ['destination_id', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const circuitBreakerState = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state per destination (1 per state label)',
  labelNames: ['destination_id', 'state'],
  registers: [register],
});

export const queueDepth = new promClient.Gauge({
  name: 'queue_depth',
  help: 'Number of messages waiting in the RabbitMQ queue per destination',
  labelNames: ['destination_id'],
  registers: [register],
});
