-- Relay: Initial Schema
-- ──────────────────────────────────────────────
-- Migration 001: core tables for destinations, events, delivery attempts,
-- and circuit breaker state.

-- ── Destinations ──────────────────────────────
-- A registered webhook endpoint owned by a customer.
CREATE TABLE IF NOT EXISTS destinations (
    id          TEXT PRIMARY KEY,             -- logical name, e.g. "acme-orders"
    owner_id    TEXT NOT NULL,                -- who owns this destination
    url         TEXT NOT NULL,                -- webhook endpoint URL
    secret      TEXT,                         -- per-destination HMAC secret (nullable; falls back to global)
    status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Events ────────────────────────────────────
-- An ingested event queued for delivery.
CREATE TABLE IF NOT EXISTS events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id    TEXT NOT NULL REFERENCES destinations(id)
                          ON DELETE RESTRICT
                          -- RESTRICT: prevent deleting a destination that has events.
                          -- The operator must drain or replay events first.
                          ,
    event_type        TEXT NOT NULL,
    payload           JSONB NOT NULL,
    idempotency_key   TEXT,                   -- client-supplied; NULL disables dedup
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent duplicate event ingestion per destination.
-- Partial index so we only enforce uniqueness when a key is actually provided.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
    ON events(destination_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Index for dashboard queries: list events by destination, newest first.
CREATE INDEX IF NOT EXISTS idx_events_destination_created
    ON events(destination_id, created_at DESC);

-- ── Delivery Attempts ─────────────────────────
-- Every HTTP delivery attempt (pending, success, or failure).
-- The retry scheduler polls next_retry_at to decide when to re-attempt.
CREATE TABLE IF NOT EXISTS delivery_attempts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id              UUID NOT NULL REFERENCES events(id)
                              ON DELETE CASCADE
                              -- CASCADE: if an event is removed (e.g. TTL cleanup),
                              -- its delivery log goes with it.
                              ,
    attempt_number        INT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'success', 'failed')),
    http_status_code      INT,               -- e.g. 200, 500, 429; NULL if connection failed
    response_body_snippet TEXT,              -- truncated response body for debugging
    attempted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_retry_at         TIMESTAMPTZ        -- when the retry scheduler should pick this up;
                                             -- NULL if no retry is scheduled (terminal state)
);

-- Index for the retry scheduler: find failed attempts due for retry.
-- Partial index to keep it small — only rows with a non-null next_retry_at.
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_next_retry
    ON delivery_attempts(next_retry_at)
    WHERE next_retry_at IS NOT NULL;

-- Index for loading delivery history per event (dashboard / replay).
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_event
    ON delivery_attempts(event_id, attempt_number);

-- ── Circuit Breaker State ─────────────────────
-- Tracks circuit breaker state per destination.
--
-- NOTE: The hot-path circuit-breaker check (is this destination's circuit OPEN?)
-- is served from Redis for speed (sub-ms read on every consumed message).
-- This Postgres table serves as: (1) a durable checkpoint so state survives
-- Redis restart, (2) the source of truth for the dashboard, and (3) a log of
-- when and why transitions happened.
--
-- The active state lives in Redis keys:
--   cb:{dest}:state       → 'closed' | 'open' | 'half_open'
--   cb:{dest}:failures    → failure count (with TTL for sliding window)
--   cb:{dest}:opened_at   → timestamp when circuit was tripped
-- The Postgres row is upserted on each transition for durability.
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    destination_id  TEXT PRIMARY KEY,
    state           TEXT NOT NULL DEFAULT 'closed'
                        CHECK (state IN ('closed', 'open', 'half_open')),
    failure_count   INT NOT NULL DEFAULT 0,
    opened_at       TIMESTAMPTZ,             -- when the circuit last tripped OPEN
    cooldown_until  TIMESTAMPTZ,             -- until when the circuit stays open
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Migration tracking ────────────────────────
-- The migrate.js runner maintains this table automatically.
CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
