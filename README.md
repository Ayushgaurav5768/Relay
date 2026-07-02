# Relay

Reliable webhook delivery platform — durable, ordered, at-least-once event delivery with exponential backoff + jitter, per-destination circuit breakers, HMAC-SHA256 signing, and a Dead Letter Queue. Inspired by Stripe and Svix.

## Architecture

```
┌─────────┐     ┌──────────┐     ┌─────────────────┐     ┌──────────────────────┐
│ Clients │ ──▶ │  Ingest  │ ──▶ │ Delivery Worker  │ ──▶ │  Destination Server  │
│  (Vite) │     │  (API)   │     │  (Consumer)      │     │  (Flaky Test Svr)    │
└─────────┘     └──────────┘     └─────────────────┘     └──────────────────────┘
                      │                    │
                      ▼                    ▼
                ┌──────────┐       ┌──────────────┐
                │PostgreSQL│       │   Dead       │
                │  Queue   │       │  Letter      │
                │          │       │   Queue      │
                └──────────┘       └──────────────┘
```

## Project Structure

```
relay/
├── packages/
│   └── lib/              # Shared library (signing, retry, models)
├── services/
│   ├── client/           # Dashboard frontend (Vite)
│   ├── dashboard-api/    # Dashboard backend API
│   ├── delivery-worker/  # Webhook delivery consumer
│   ├── ingest/           # Event ingestion API
│   └── flaky-endpoint-test-server/  # Test destination server
├── db/
│   └── migrations/       # SQL migration files
├── infra/                # Infrastructure configs
├── scripts/              # Utility scripts
├── tests/                # Integration / E2E tests
├── load-tests/           # Load testing scripts
└── docker-compose.yml    # Local development setup
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/Ayushgaurav5768/Relay.git
cd Relay
npm install

# Start all services
docker compose up -d

# Run migrations
# (coming soon)
```

## Services

| Service | Description | Port |
|---------|-------------|------|
| **Ingest** | Event ingestion API — receives webhook events and enqueues them | — |
| **Delivery Worker** | Consumes events from the queue and delivers to destinations with retry logic | — |
| **Dashboard API** | REST API for managing endpoints, viewing delivery logs, and DLQ | — |
| **Client** | Web dashboard (Vite + React) | — |
| **Flaky Test Server** | Simulates unreliable destinations for testing | — |

## Features

- **At-least-once delivery** with configurable retry policies
- **Exponential backoff + jitter** to avoid thundering herd
- **Per-destination circuit breakers** to isolate failing endpoints
- **HMAC-SHA256 signing** for payload verification
- **Dead Letter Queue** for undeliverable events
- **Ordered delivery** per destination
- **Durable queue** backed by PostgreSQL

## Tech Stack

- **Runtime:** Node.js
- **Language:** JavaScript (ESM)
- **Queue:** PostgreSQL-based
- **Infrastructure:** Docker Compose
