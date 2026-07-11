# Relay

Reliable webhook delivery platform — durable, ordered, at-least-once event delivery with
per-destination concurrency control, HMAC-SHA256 signing, Redis token-bucket rate limiting,
PostgreSQL-backed outbox pattern, exponential-backoff retries with full jitter, a Redis
circuit breaker, Prometheus metrics, and a React dashboard.

Inspired by Stripe and Svix.

## Architecture

```
Client → POST /events → Ingest Service → Postgres (outbox) → RMQ → Delivery Worker → Customer Webhook
                                                                 ↓
                                                            Circuit Breaker (Redis)
                                                                 ↓
                                                         Retry Scheduler → DLQ/Replay
                                                                 ↓
                                                     Prometheus Metrics (/metrics)
```

## Project Structure

```
relay/
├── packages/
│   └── lib/                  # Shared library
│       └── src/
│           ├── config.js            # Zod-validated env config
│           ├── db.js                # PostgreSQL pool + transactions
│           ├── redis.js             # Redis client (ioredis)
│           ├── rabbitmq.js          # RMQ connection + topic exchange
│           ├── logger.js            # Pino structured JSON logger
│           ├── metrics.js           # Prometheus metrics registry (all 7 metrics)
│           ├── circuitBreaker.js    # Redis-backed CB state machine (4 Lua scripts)
│           ├── verifySignature.js   # Customer-facing HMAC verification SDK
│           ├── validateUrl.js       # DNS-based SSRF CIDR checker
│           ├── types.js             # JSDoc typedefs
│           └── repositories/
│               ├── DestinationRepository.js    # CRUD + secret auto-generation
│               ├── EventRepository.js          # Insert, status update, paginated list with attempt count
│               ├── DeliveryAttemptRepository.js # Insert, find by event, claim due retries
│               └── OutboxRepository.js          # Insert + claim unpublished
├── services/
│   ├── ingest/               # Event ingestion API + Dashboard API routes (port 3001)
│   │   ├── src/
│   │   │   ├── index.js            # Express app, /health, /metrics
│   │   │   ├── events.js           # POST /events, GET /events, GET /events/:id,
│   │   │   │                       # POST /events/:id/replay, GET /destinations
│   │   │   ├── auth.js             # API key Basic auth middleware
│   │   │   ├── rateLimiter.js      # Redis token-bucket middleware
│   │   │   ├── payloadSizeLimit.js # 413 middleware (max 1MB)
│   │   │   └── outboxPublisher.js  # Polls outbox → publishes to RMQ
│   │   └── tests/
│   │       ├── events.test.js              # 30 unit tests
│   │       └── events.integration.test.js  # 2 integration tests
│   ├── delivery-worker/      # Webhook delivery consumer (port 3002)
│   │   ├── src/
│   │   │   ├── index.js           # Express app, /health, /metrics, CB state collector
│   │   │   ├── consumer.js        # RMQ consumer, CB integration, queue depth collector
│   │   │   ├── deliver.js         # HTTP POST via undici, timing histogram
│   │   │   ├── signer.js          # HMAC-SHA256 signature generation
│   │   │   ├── retryScheduler.js  # Exponential backoff with full jitter
│   │   │   └── retryWorker.js     # Polls due retries, re-publishes to RMQ
│   │   └── tests/
│   │       ├── consumer.test.js              # 17 unit tests
│   │       ├── consumer.integration.test.js   # 1 integration test
│   │       ├── circuitBreaker.integration.test.js  # 1 integration test
│   │       ├── retry.integration.test.js      # 3 integration tests
│   │       ├── retryScheduler.test.js         # 7 unit tests
│   │       └── signer.test.js                 # 7 unit tests
│   ├── dashboard-api/        # Dashboard backend BFF (port 3003)
│   │   └── src/index.js      # /health, /metrics
│   ├── client/               # React dashboard (Vite 6 + React 18, port 5173)
│   │   ├── src/
│   │   │   ├── main.jsx              # Entry point
│   │   │   ├── App.jsx               # Root with tab nav (Destinations / Events)
│   │   │   ├── App.css               # Dark theme styles
│   │   │   ├── api.js                # Fetch wrapper (/api/* → ingest)
│   │   │   └── components/
│   │   │       ├── DestinationList.jsx   # Table with health indicators (polls 5s)
│   │   │       ├── EventList.jsx         # Paginated table, filters, clickable rows
│   │   │       ├── EventDetail.jsx       # Event info + timeline + replay
│   │   │       ├── Timeline.jsx          # Vertical attempt timeline
│   │   │       ├── ReplayButton.jsx      # Optimistic UI replay
│   │   │       ├── HealthIndicator.jsx   # Colored dot (green/yellow/red/gray)
│   │   │       ├── ErrorBoundary.jsx     # Error boundary with retry
│   │   │       └── LoadingSpinner.jsx    # Animated spinner
│   │   └── vite.config.js     # Proxy /api → localhost:3001
│   └── flaky-endpoint-test-server/  # Configurable test destination (port 9099)
├── db/
│   ├── migrations/
│   │   ├── 001_initial.sql   # Core tables (destinations, events, attempts, CB state)
│   │   ├── 002_outbox.sql    # Outbox table for reliable publishing
│   │   └── 003_dlq.sql       # events.status column (pending/delivered/failed/dead)
│   └── migrate.js            # Migration runner
├── scripts/
│   ├── migrate.js            # Apply migrations
│   └── seed.js               # Test data seeder
├── infra/                    # Docker Compose, Terraform
├── load-tests/               # k6 scripts
├── docker-compose.yml        # Full local dev stack
├── .env.example              # All environment variables documented
├── eslint.config.js          # ESLint flat config
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/Ayushgaurav5768/Relay.git
cd Relay
npm install

# Start all services (PostgreSQL 16, Redis 7, RabbitMQ 3, all Node services)
docker compose up -d --build

# Run migrations
node scripts/migrate.js

# (Optional) Seed test data
node scripts/seed.js

# Open the dashboard
open http://localhost:5173
```

For local development without Docker (services need infra running):

```bash
# Start dependencies
docker compose up -d postgres redis rabbitmq flaky-server

# Start each service in its own terminal
npm run dev --workspace=@relay/ingest
npm run dev --workspace=@relay/delivery-worker
npm run dev --workspace=@relay/dashboard-api
npm run dev --workspace=@relay/client    # Vite dev server on :5173
```

## Services

| Service | Description | Port | Endpoints |
|---------|-------------|------|-----------|
| **Ingest** | Event ingestion + Dashboard API | 3001 | `POST /events`, `GET /events`, `GET /events/:id`, `POST /events/:id/replay`, `GET /destinations`, `/health`, `/metrics` |
| **Delivery Worker** | Consumes + delivers + retries | 3002 | `/health`, `/metrics` |
| **Dashboard API** | BFF for frontend | 3003 | `/health`, `/metrics` |
| **Client** | React dashboard (Vite) | 5173 | Proxies `/api` → ingest |
| **Flaky Test Server** | Simulates unreliable endpoints | 9099 | `POST /` (configurable failure/latency) |
| **PostgreSQL** | Primary datastore | 5432 | — |
| **Redis** | Cache / hot-path | 6379 | — |
| **RabbitMQ** | Message broker | 5672 / 15672 | — |

## Features

### Implemented

- **At-least-once delivery** via PostgreSQL outbox pattern — event + outbox row in same transaction;
  background publisher polls and publishes to RMQ; crash recovery ensures no events are lost
- **Per-destination ordering and concurrency** — RMQ topic exchange with one queue per destination;
  per-consumer prefetch prevents one destination's backlog from starving others
- **Idempotency key deduplication** — unique partial index + 23505 race recovery
- **Redis token-bucket rate limiting** — continuous refill, configurable rate per API key
- **HMAC-SHA256 payload signing** — each delivery includes `X-Relay-Signature: t=<ts>,v1=<hex>` header
- **Customer-facing verification SDK** — `verifySignature()` with constant-time compare, 300s tolerance
- **Exponential backoff retry with full jitter** — 2s base, 5min cap, random jitter per AWS retry paper
- **Retry scheduler + worker** — polls `delivery_attempts` for due retries, re-publishes to RMQ
- **Dead Letter Queue (DLQ)** — after 8 failed attempts, event status = `dead`, no more retries
- **DLQ Replay** — `POST /events/:id/replay` clears attempts, resets to pending, re-inserts outbox row; auth-gated
- **Redis circuit breaker** — per-destination state machine (CLOSED → OPEN → HALF_OPEN → CLOSED);
  atomic Lua transitions, exponential cooldown backoff (30s→60s→120s→240s→300s);
  consumer pause on OPEN via `channel.cancel()`, auto-resume on cooldown expiry
- **SSRF hardening** — DNS-resolution-based CIDR checks for private ranges (127.0.0.0/8, 10.0.0.0/8,
  172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fd00::/8)
- **Payload size limit** — 413 if `Content-Length` > 1MB
- **Secret auto-generation** — `crypto.randomBytes(32).toString('hex')` when no secret provided;
  never logged or returned in API responses
- **Zod request validation** — clear 400 errors with field-level details
- **Basic auth** — API key per destination owner
- **Structured JSON logging** — Pino with `event_id`, `destination_id`, etc. threaded through
  ingest → queue → delivery → retry → DLQ
- **Prometheus metrics** — 7 metrics across all services, exposed on `GET /metrics`
- **React dashboard** — dark-themed UI with:
  - Destination health indicators (green=CLOSED, yellow=HALF_OPEN, red=OPEN, gray=unknown)
  - Paginated event log with destination/status filters
  - Event detail with vertical delivery attempt timeline
  - Optimistic replay button for DLQ'd events
  - Error boundary + loading states
  - 5-second polling for near-real-time updates
- **Comprehensive test suite** — 94 unit/integration tests (Vitest), all passing

### Coming Soon (Phase 9)

- Long-term `circuit_breaker_state` table — durable storage with Redis backfill
- Grafana dashboard for Prometheus metrics
- CI/CD pipeline (GitHub Actions)
- Per-destination rate limiting
- Webhook secret rotation

## API

### `POST /events`

Create a new webhook event.

**Headers:**
```
Authorization: Basic <base64(api_key:)>
Content-Type: application/json
```

**Body:**
```json
{
  "destination_id": "acme-orders",
  "event_type": "order.created",
  "payload": { "order_id": 1001, "total": 49.99 },
  "idempotency_key": "unique-key-123"
}
```

**Responses:**
- `201` — event created and queued for delivery
- `200` — duplicate idempotency key (`{ "event_id": "...", "duplicate": true }`)
- `400` — validation error
- `401` — missing or invalid API key
- `403` — destination belongs to another owner
- `404` — destination not found
- `413` — payload exceeds 1MB limit
- `422` — destination is disabled
- `429` — rate limit exceeded
- `500` — internal error

### `GET /events`

Paginated event list with attempt counts.

**Query params:** `page`, `limit`, `destination_id`, `status`

### `GET /events/:id`

Event detail with full delivery attempt timeline.

### `POST /events/:id/replay`

Replay a dead-lettered event (clears attempts, resets to pending).

### `GET /destinations`

List destinations with circuit-breaker-derived health status.

## Dashboard

The React dashboard runs on port **5173** and auto-proxies `/api` requests to the ingest service (port 3001).

**Screens:**
- **Destinations** — Table with colored health dots; polls every 5 seconds
- **Events** — Paginated table, filterable by destination and status; click a row for details
- **Event Detail** — Info card + vertical timeline of delivery attempts + Replay button for dead events

## Metrics

Each service exposes `GET /metrics`:

| Metric | Type | Labels | Service |
|---|---|---|---|
| `events_ingested_total` | Counter | `destination_id` | Ingest |
| `events_delivered_total` | Counter | `destination_id` | Delivery Worker |
| `events_failed_total` | Counter | `destination_id` | Delivery Worker |
| `events_dlq_total` | Counter | `destination_id` | Delivery Worker |
| `delivery_attempt_duration_seconds` | Histogram | `destination_id`, `status` | Delivery Worker |
| `circuit_breaker_state` | Gauge | `destination_id`, `state` | Delivery Worker |
| `queue_depth` | Gauge | `destination_id` | Delivery Worker |

Plus Node.js default metrics (CPU, memory, event loop, etc.) via `prom-client` defaults.

## Testing

```bash
# All unit tests
cd packages/lib && npm test          # 26 tests (signature + CB)
cd services/ingest && npm test       # 32 tests
cd services/delivery-worker && npm test  # 36 tests

# Integration tests (requires Docker services running)
npx vitest run services/ingest/tests/events.integration.test.js
npx vitest run services/delivery-worker/tests/consumer.integration.test.js

# Lint
npm run lint
```

## Tech Stack

- **Runtime:** Node.js 20 (ESM)
- **Database:** PostgreSQL 16
- **Cache:** Redis 7
- **Message Broker:** RabbitMQ 3
- **HTTP Client:** undici
- **Validation:** Zod
- **Logging:** Pino
- **Metrics:** prom-client
- **Frontend:** Vite 6 + React 18
- **Testing:** Vitest + Supertest
- **Infrastructure:** Docker Compose
