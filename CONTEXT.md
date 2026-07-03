# Relay — Full Project Context

## Architecture
```
Client → POST /events → Ingest Service → Postgres (outbox) → RMQ → Delivery Worker → Customer Webhook
                                                                 ↓
                                                            Circuit Breaker (Redis)
                                                                 ↓
                                                         Retry Scheduler → DLQ/Replay
```

## Repo Structure
```
Relay/
├── packages/lib/              — Shared library (DB, Redis, RMQ, repos, CB, config, metrics)
├── services/
│   ├── ingest/                — Ingest API (auth, rate limit, outbox publisher, Dashboard API routes)
│   ├── delivery-worker/       — Consumer, delivery, retry scheduler/worker, CB integration
│   ├── dashboard-api/         — BFF for dashboard (currently thin, proxies ingest routes in dev)
│   └── client/                — React dashboard (Vite + JSX, port 5173)
├── db/migrations/             — 001_initial.sql, 002_outbox.sql, 003_dlq.sql
├── scripts/seed.js            — Seed data for dev
├── infra/                     — Docker Compose, Terraform
├── load-tests/                — k6 scripts
└── CONTEXT.md                 ← this file
```

## Ports
| Service | Port | Env Var |
|---|---|---|
| Ingest API | 3001 | INGEST_PORT |
| Delivery Worker | 3002 | DELIVERY_WORKER_PORT |
| Dashboard API | 3003 | DASHBOARD_PORT |
| Vite Client | 5173 | CLIENT_PORT |
| Flaky Test Server | 9099 | FLAKY_PORT |
| PostgreSQL | 5432 | PGPORT |
| Redis | 6379 | REDIS_PORT |
| RabbitMQ | 5672 / 15672 | RABBITMQ_PORT |

## What Has Been Built (9 phases)

### Phase 1-2: Foundation + Ingest
- Express API with Basic auth, Zod validation, Redis token-bucket rate limiter
- `POST /events` — creates event + outbox row in single transaction
- Idempotency key dedup (unique partial index + 23505 race recovery)
- Outbox publisher: background interval polling `outbox` table → RMQ topic exchange

### Phase 3-4: Delivery Worker + Retry
- Per-destination RMQ queues with independent consumers
- `consumer.js` — handles delivery, persists attempts, computes retry backoff
- `deliver.js` — HTTP POST via undici
- `retryScheduler.js` — exponential backoff with full jitter (2s base, 5min cap)
- `retryWorker.js` — polls for due retries, re-publishes to RMQ
- DLQ: after MAX_ATTEMPTS (8), event status = 'dead', no more retries

### Phase 5: DLQ + Replay
- Migration 003: `status` column on `events` (pending/delivered/failed/dead)
- `POST /events/:id/replay` — clears attempts, resets to pending, re-inserts outbox row
- Auth gated: event must be dead, destination must exist/active/belong to owner

### Phase 6a: Payload Signing
- `signer.js` — HMAC-SHA256 over `${timestamp}.${raw_payload_body}`
- Header: `X-Relay-Signature: t=<ts>,v1=<hex>`
- `deliver.js` signs every outbound webhook
- SDK: `packages/lib/src/verifySignature.js` — constant-time compare, 300s tolerance
- 10 unit tests

### Phase 6b: Circuit Breaker
- Per-destination CB state machine in Redis: CLOSED → OPEN → HALF_OPEN → CLOSED
- Lua scripts for atomic transitions: `CB_ON_SUCCESS`, `CB_ON_FAILURE`, `CB_PROBE_ALLOWED`, `CB_GET_STATE`
- Cooldown backoff: 30s→60s→120s→240s→300s (capped 5min, exponential by open_count)
- Consumer pause: `channel.cancel()` on OPEN state, scheduled resume
- Integration test: Dest A fails → OPEN, Dest B succeeds → CLOSED

### Phase 7a: SSRF Hardening + Payload Size Limit
- `packages/lib/src/validateUrl.js` — DNS-resolution-based CIDR checks (private ranges)
- `services/ingest/src/payloadSizeLimit.js` — 413 if Content-Length > 1MB
- `POST /destinations` endpoint with SSRF validation

### Phase 8a: Dashboard API (Backend)
Routes live in `services/ingest/src/events.js` (mounted on ingest Express app):
- `GET /destinations` — list with health derived from Redis CB state (healthy/degraded/unhealthy/unknown)
- `GET /events` — paginated, filterable by destination_id/status, with attempt_count via correlated subquery
- `GET /events/:id` — event + delivery attempt timeline
- `POST /events/:id/replay` — reuses Phase 5b replay logic

### Phase 8b: React Dashboard UI
`services/client/src/` — Vite 6 + React 18, dark theme, polls every 5s:
- `DestinationList.jsx` — table with colored health indicators (green/yellow/red/gray)
- `EventList.jsx` — paginated table, filter by destination/status, clickable rows → detail
- `EventDetail.jsx` — event info card + vertical timeline of delivery attempts
- `Timeline.jsx` — colored markers per attempt (green=success, red=failed, gray=pending)
- `ReplayButton.jsx` — optimistic UI: immediately hides button, reverts on API error
- `ErrorBoundary.jsx` + `LoadingSpinner.jsx`
- `api.js` — fetch wrapper, `/api` prefix proxied to ingest service

Vite config proxies `/api` → `localhost:3001` with path rewrite (strip `/api`).

### Phase 8c: Prometheus Metrics
`packages/lib/src/metrics.js` — shared registry with:
- `events_ingested_total` (counter, destination_id) — ingest
- `events_delivered_total` (counter, destination_id) — delivery worker
- `events_failed_total` (counter, destination_id) — delivery worker
- `events_dlq_total` (counter, destination_id) — delivery worker
- `delivery_attempt_duration_seconds` (histogram, destination_id + status) — delivery worker
- `circuit_breaker_state` (gauge, destination_id + state) — delivery worker
- `queue_depth` (gauge, destination_id) — delivery worker

Each service exposes `GET /metrics`. CB state collected every 10s via Redis KEYS. Queue depth every 15s via `channel.checkQueue()`.

### Phase 9a: Prometheus + Grafana Observability
- Prometheus service in docker-compose.yml scraping all 3 services on 5s intervals, 7-day retention
- Grafana auto-provisioned with Prometheus datasource and `relay-overview.json` dashboard (10 panels)
- Dashboard panels: ingestion rate, delivery success rate, DLQ rate, active events by status, latency p50/p95/p99, CB state table + timeline, queue depth, cumulative counters
- `docs/observability.md` — metric reference with alert thresholds for every gauge
- `infra/prometheus/prometheus.yml` — scrape config
- `infra/grafana/datasources/` + `infra/grafana/dashboards/` — auto-provisioning config

### Phase 9b: Load Test + Verification + Expanded Unit Tests
- `load-tests/load-test.js` — k6 ramping-arrival-rate script: 200 req/s sustained across 3 destinations (always-succeed, flaky-dest, always-fail)
- `load-tests/seed-load-test.js` — seeds 3 test destinations with matching /succeed and /fail endpoints
- `load-tests/verifyLoadTest.js` — Postgres verification: asserts terminal status, delivery order (FIFO), latency isolation between healthy and failing destinations
- Bug fix: `EventRepository.insert` and `OutboxRepository.insert` — fixed lost `this` context on `client.query` via `.bind(client)`
- Flaky server updated: `/succeed` (always 200), `/fail` (always 500) endpoints added alongside `/webhook`
- `packages/lib/tests/repositories.test.js` — 48 unit tests covering all 4 repositories (Event, Outbox, Destination, DeliveryAttempt) with mocked `query`
- `packages/lib/tests/circuitBreaker-edge.test.js` — 10 CB edge case tests (already OPEN, probe in all states, cooldown retry_after, eval argument verification)
- `services/delivery-worker/tests/signer.test.js` — 6 new edge cases (unicode, 100KB payload, special characters, long secret, empty secret, zero timestamp)
- `services/delivery-worker/tests/retryScheduler.test.js` — 4 new edge cases (no negative delay, maxRetries=0, last allowed attempt, full jitter distribution)

## Database Schema
```
destinations (id TEXT PK, owner_id, url, secret, status, created_at)
events (id UUID PK, destination_id FK, event_type, payload JSONB, idempotency_key, status, created_at)
delivery_attempts (id UUID PK, event_id FK CASCADE, attempt_number, status, http_status_code, response_body_snippet, attempted_at, next_retry_at)
outbox (id UUID PK, event_id FK CASCADE, destination_id, routing_key, payload JSONB, published BOOL, created_at, published_at)
circuit_breaker_state (destination_id TEXT PK, state, failure_count, opened_at, cooldown_until, updated_at)
```

## Key Config (packages/lib/src/config.js)
| Var | Default | Notes |
|---|---|---|
| MAX_RETRIES | 5 | Number of retry attempts allowed |
| MAX_ATTEMPTS | 8 | Total attempts = 1 initial + 7 retries |
| RETRY_POLL_INTERVAL_MS | 1000 | Retry worker poll frequency |
| DELIVERY_CONCURRENCY | 5 | Per-destination in-flight limit |
| CB_FAILURE_THRESHOLD | 5 | Consecutive failures before OPEN |
| CB_COOLDOWN_SECONDS | 30 | Base cooldown (doubles per open_count) |
| LOG_LEVEL | info | Pino log level |
| INGEST_RATE_LIMIT_RATE | 10 | Requests per interval |
| INGEST_RATE_LIMIT_INTERVAL_MS | 1000 | Rate limit window |

## Test Results
- lib: 84 tests (10 verifySignature + 26 CB + 48 repositories)
- ingest: 32 unit tests (30 events.test.js + 2 integration)
- delivery-worker: 40 tests (17 consumer + 11 retryScheduler + 13 signer + 5 integration)
- Total: 156 tests — all passing
- Lint: clean (1 pre-existing seed.js issue)

## Git
Remote: https://github.com/Ayushgaurav5768/Relay.git
Current HEAD: 13efd11 on main

## What's Next
- `circuit_breaker_state` table — long-term storage with backfill from Redis
- CI/CD (GitHub Actions), rate limit per-destination, webhook secret rotation
