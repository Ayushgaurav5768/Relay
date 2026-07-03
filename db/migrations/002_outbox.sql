-- Relay: Outbox Table
-- ──────────────────────────────────────────────
-- Migration 002: outbox for reliable event publishing to RabbitMQ.
--
-- Dual-write mitigation (outbox pattern):
-- The event row and the outbox row are inserted in the same Postgres
-- transaction. A background publisher (outboxPublisher.js) polls this
-- table, publishes to RabbitMQ, and marks the row published.
--
-- This gives us at-least-once delivery:
--   - If the process crashes after the transaction commits but before
--     the RMQ publish, the publisher picks up the unpublished row on
--     restart.
--   - If the publisher crashes after the RMQ publish but before marking
--     the row published, the message may be sent twice (at-least-once).
--     Downstream consumers must be idempotent (event_id is the
--     deduplication key).
--
-- An alternative would be to use RabbitMQ publisher confirms with
-- transacted channels, but that couples the DB transaction to the RMQ
-- transaction, which adds latency and complexity. The outbox pattern
-- keeps the write path fast (just the local DB transaction) and
-- defers the RMQ publish to a background process.

CREATE TABLE IF NOT EXISTS outbox (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID NOT NULL REFERENCES events(id)
                          ON DELETE CASCADE,
    destination_id    TEXT NOT NULL,
    routing_key       TEXT NOT NULL,
    payload           JSONB NOT NULL,
    published         BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
    ON outbox(created_at)
    WHERE published = false;
