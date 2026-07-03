-- Relay: Dead Letter Queue
-- Migration 003: adds event-level status tracking for DLQ transitions
-- and replay support.

-- ── Events Status ───────────────────────────
ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'delivered', 'failed', 'dead'));

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
