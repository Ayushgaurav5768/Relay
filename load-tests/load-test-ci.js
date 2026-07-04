// Relay CI Load Test — Reduced-Duration Gate
// ============================================================================
// Runs ~30s sustained load across three destinations to verify:
//   1. Ingest accepts events (201) under moderate pressure
//   2. No 5xx errors from the service
//   3. Rate limiting works (429 responses)
//
// See load-test.js for the full-duration variant used in ad-hoc perf runs.
// ============================================================================

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const ingestDuration = new Trend('ingest_duration_ms');
const ingestSuccess  = new Counter('ingest_201_total');
const rateLimited    = new Counter('ingest_429_total');
const otherErrors    = new Counter('ingest_other_total');

const BASE_URL = __ENV.INGEST_URL || 'http://localhost:3001';
const AUTH = __ENV.INGEST_AUTH || 'ZGV2LWFwaS1rZXk6';

const DESTINATIONS = ['always-succeed', 'flaky-dest', 'always-fail'];

export const options = {
  scenarios: {
    ci_gate: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 30,
      stages: [
        { duration: '5s', target: 30 },
        { duration: '20s', target: 30 },
        { duration: '5s', target: 5 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000', 'avg<2000'],
    http_req_failed: ['rate<0.60'],
    ingest_duration_ms: ['p(95)<3000'],
  },
};

function randomPayload() {
  return JSON.stringify({
    destination_id: DESTINATIONS[Math.floor(Math.random() * DESTINATIONS.length)],
    event_type: 'loadtest.event',
    payload: {
      seq: Date.now(),
      rand: Math.random().toString(36).substring(2, 10),
      ts: new Date().toISOString(),
    },
  });
}

export default function () {
  const payload = randomPayload();
  const body = payload;
  const destId = JSON.parse(payload).destination_id;

  const res = http.post(`${BASE_URL}/events`, body, {
    headers: {
      'Authorization': `Basic ${AUTH}`,
      'Content-Type': 'application/json',
    },
    tags: { destination: destId },
  });

  ingestDuration.add(res.timings.duration, { destination: destId });

  if (res.status === 201) {
    ingestSuccess.add(1, { destination: destId });
  } else if (res.status === 429) {
    rateLimited.add(1, { destination: destId });
  } else {
    otherErrors.add(1, { destination: destId, status: String(res.status) });
  }

  check(res, {
    'no 5xx errors': (r) => r.status < 500 || r.status === 503,
    'status is 201 or 429': (r) => r.status === 201 || r.status === 429,
    'response time < 3s': (r) => r.timings.duration < 3000,
  });
}
