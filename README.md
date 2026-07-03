# Relay

Reliable webhook delivery platform — durable, ordered, at-least-once event delivery with
per-destination concurrency control, HMAC-SHA256 signing, Redis token-bucket rate limiting,
PostgreSQL-backed outbox pattern for reliable publishing, and a dashboard for observability.

Inspired by Stripe and Svix.

## Architecture

```
                    ┌──────────┐
                    │  Clients │
                    │  (Vite)  │
                    └────┬─────┘
                         │ POST /events  (Basic auth + Rate limited)
                         ▼
                    ┌──────────┐     outbox table     ┌──────────────────┐
                    │  Ingest  │ ──────────────────▶  │  Outbox Publisher │
                    │  (API)   │     (same txn)       │  (background)     │
                    └──────────┘                      └────────┬─────────┘
                         │                                     │ publish to
                         ▼                                     │ topic exchange
                    ┌──────────┐                               ▼
                    │PostgreSQL│                        ┌──────────────┐
                    │          │                        │  RabbitMQ    │
                    │ events   │                        │  relay.events│
                    │ outbox   │                        └──────┬───────┘
                    │ delivery │                               │ per-destination
                    │_attempts │                               │ queues
                    │ circuit  │                               ▼
                    │_breaker  │                        ┌──────────────────┐
                    └──────────┘                        │ Delivery Worker  │
                                                        │  (Consumer)      │
                                        ┌───────────────┴────────┬─────────┘
                                        │                        │
                                        ▼                        ▼
                                   ┌──────────┐            ┌──────────┐
                                   │PostgreSQL│            │  Redis   │
                                   │(attempts)│            │(circuit  │
                                   └──────────┘            │ breaker  │
                                                           │ hot-path)│
                                                           └──────────┘
                                        │
                                        │ HTTP POST + HMAC-SHA256
                                        ▼
                                   ┌──────────────────────┐
                                   │  Destination Server  │
                                   │  (Flaky Test Svr)    │
                                   └──────────────────────┘
```

## Project Structure

```
relay/
├── packages/
│   └── lib/                  # Shared library
│       └── src/
│           ├── config.js      # Zod-validated env config
│           ├── db.js          # PostgreSQL pool + transactions
│           ├── redis.js       # Redis client
│           ├── rabbitmq.js    # RMQ connection + topic exchange
│           ├── logger.js      # Pino structured logger
│           ├── types.js       # JSDoc typedefs
│           └── repositories/  # Data access layer
│               ├── DestinationRepository.js
│               ├── EventRepository.js
│               ├── DeliveryAttemptRepository.js
│               ├── OutboxRepository.js
│               └── CircuitBreakerRepository.js  (forthcoming)
├── services/
│   ├── ingest/               # Event ingestion API (port 3001)
│   │   ├── src/
│   │   │   ├── index.js       # Express app + health check
│   │   │   ├── events.js      # POST /events + GET /events/:id
│   │   │   ├── auth.js        # API key Basic auth middleware
│   │   │   ├── rateLimiter.js # Redis token-bucket middleware
│   │   │   └── outboxPublisher.js  # Polls outbox → publishes to RMQ
│   │   └── tests/
│   ├── delivery-worker/      # Webhook delivery consumer (port 3002)
│   │   ├── src/
│   │   │   ├── index.js       # Express app + health check
│   │   │   ├── consumer.js    # RMQ consumer with per-destination concurrency
│   │   │   ├── deliver.js     # HTTP POST via undici
│   │   │   └── signer.js      # HMAC-SHA256 signing
│   │   └── tests/
│   ├── dashboard-api/        # Dashboard backend API (port 3003)
│   ├── client/               # Dashboard frontend (Vite + React, port 5173)
│   └── flaky-endpoint-test-server/  # Configurable test destination
├── db/
│   └── migrations/           # SQL migration files
│       ├── 001_initial.sql   # Core tables (destinations, events, attempts, circuit breaker)
│       └── 002_outbox.sql    # Outbox table for reliable RMQ publishing
├── scripts/
│   ├── migrate.js            # Migration runner
│   └── seed.js               # Test data seeder
├── docker-compose.yml        # Local development setup
└── .env.example              # All environment variables documented
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
```

## Services

| Service | Description | Port |
|---------|-------------|------|
| **Ingest** | Event ingestion API — receives webhook events, validates via Zod, deduplicates by idempotency key, writes event + outbox in a single transaction | 3001 |
| **Delivery Worker** | Consumes events from per-destination RMQ queues, delivers via HTTP POST with HMAC-SHA256 signing, persists delivery attempts | 3002 |
| **Dashboard API** | REST API for managing endpoints, viewing delivery logs | 3003 |
| **Client** | Web dashboard (Vite + React) | 5173 |
| **Flaky Test Server** | Simulates unreliable destinations for testing (configurable failure/latency rate) | 9099 |
| **PostgreSQL** | Primary datastore — events, outbox, delivery attempts, circuit breaker state | 5432 |
| **Redis** | Cache / hot-path — rate limiter token buckets, circuit breaker fast reads | 6379 |
| **RabbitMQ** | Message broker — topic exchange with per-destination queues for ordered delivery | 5672 / 15672 |

## Features

### Implemented

- **At-least-once delivery** via PostgreSQL outbox pattern — event + outbox row in same transaction;
  background publisher polls and publishes to RMQ; crash recovery ensures no events are lost
- **Per-destination ordering** via RMQ topic exchange (one queue per destination)
- **Per-destination concurrency control** — RMQ per-consumer prefetch prevents one destination's
  backlog from starving others
- **Idempotency key deduplication** — unique partial index + 23505 race recovery
- **Redis token-bucket rate limiting** — continuous refill, configurable rate per API key
- **HMAC-SHA256 signing** — each delivery includes `X-Relay-Signature-256` header
- **Zod request validation** — clear 400 errors with field-level details
- **Basic auth** — API key per destination owner
- **Structured logging** — Pino JSON logger with correlation IDs (event_id on every log line)
- **Comprehensive test suite** — Vitest unit tests + Docker-based integration tests

### Coming Soon

- Retry scheduling with exponential backoff + jitter
- Per-destination circuit breakers (Redis hot-path, Postgres durability)
- Dead Letter Queue for permanently failed events
- Dashboard API + frontend for managing destinations and viewing logs
- CI/CD pipeline (GitHub Actions)
- Load testing (k6)

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
- `422` — destination is disabled
- `429` — rate limit exceeded
- `500` — internal error

### `GET /events/:id`

Fetch event details (requires auth).

## Testing

```bash
# Unit tests
cd services/ingest && npx vitest run
cd services/delivery-worker && npx vitest run

# Integration tests (requires Docker services running)
cd services/ingest && npx vitest run events.integration.test.js
cd services/delivery-worker && npx vitest run consumer.integration.test.js

# All tests
npm test
```

## Tech Stack

- **Runtime:** Node.js 20 (ESM)
- **Database:** PostgreSQL 16
- **Cache:** Redis 7
- **Message Broker:** RabbitMQ 3
- **HTTP Client:** undici
- **Validation:** Zod
- **Logging:** Pino
- **Testing:** Vitest + Supertest
- **Infrastructure:** Docker Compose
