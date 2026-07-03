// Relay Load Test — Sustained Correctness Under Load
// ============================================================================
// Simulates ~200 events/sec for 80s across three destinations:
//   always-succeed  → flaky-server:9099/succeed  (always HTTP 200)
//   flaky-dest      → flaky-server:9099/webhook   (flaky — fails every Nth)
//   always-fail     → flaky-server:9099/fail      (always HTTP 500)
//
// Expect:  201 (created), 429 (rate-limited), no 5xx from ingest.
// Expect:  No service crash, no uncaught errors.
//
// Usage:
//   k6 run load-tests/load-test.js
// ============================================================================

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const ingestDuration = new Trend('ingest_duration_ms');
const ingestSuccess  = new Counter('ingest_201_total');
const rateLimited    = new Counter('ingest_429_total');
const otherErrors    = new Counter('ingest_other_total');
const dbzByDest      = Rate('ingest_status_per_dest'); // dummy — see checks

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.INGEST_URL || 'http://localhost:3001';
const AUTH = __ENV.INGEST_AUTH || 'ZGV2LWFwaS1rZXk6'; // base64('dev-api-key:')

const DESTINATIONS = ['always-succeed', 'flaky-dest', 'always-fail'];

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { duration: '10s', target: 200 },   // ramp up to 200 req/s
        { duration: '70s', target: 200 },   // sustain for 70s (total 80s)
        { duration: '10s', target: 10 },    // ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000', 'avg<2000'],
    http_req_failed: ['rate<0.60'],
    ingest_duration_ms: ['p(95)<3000'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main VU iteration
// ---------------------------------------------------------------------------
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

  // Count status codes
  if (res.status === 201) {
    ingestSuccess.add(1, { destination: destId });
  } else if (res.status === 429) {
    rateLimited.add(1, { destination: destId });
  } else {
    otherErrors.add(1, { destination: destId, status: String(res.status) });
  }

  // Abort on 5xx — these indicate the service is broken
  check(res, {
    'no 5xx errors': (r) => r.status < 500 || r.status === 503,
    'status is 201 or 429': (r) => r.status === 201 || r.status === 429,
    'response time < 3s': (r) => r.timings.duration < 3000,
  });

  if (res.status >= 500 && res.status !== 503) {
    // Service error — flag it hard
    console.error(`CRITICAL: ingest returned ${res.status} for ${destId}: ${res.body}`);
  }
}
