-- Schema for the webhook delivery service. Four tables; see CONTEXT.md.
-- Timestamps are ISO-8601 TEXT (UTC). JSON columns store TEXT.
PRAGMA journal_mode = WAL;

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS
   endpoints (
      id TEXT PRIMARY KEY, -- ep_<uuid>
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_types TEXT NOT NULL, -- JSON array, or ["*"]
      state TEXT NOT NULL DEFAULT 'active', -- active | disabled
      disabled_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS
   events (
      id TEXT PRIMARY KEY, -- evt_<uuid>
      type TEXT NOT NULL,
      data TEXT NOT NULL, -- JSON object
      created_at TEXT NOT NULL
   );

CREATE TABLE IF NOT EXISTS
   deliveries (
      id TEXT PRIMARY KEY, -- dlv_<uuid>
      event_id TEXT NOT NULL REFERENCES events (id),
      endpoint_id TEXT NOT NULL REFERENCES endpoints (id),
      status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|delivered|failed|canceled
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT, -- when this becomes due (backoff)
      claimed_at TEXT, -- set when claimed; drives visibility timeout
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
   );

-- The worker's hot path: find due rows by (status, next_attempt_at).
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS
   attempts (
      id TEXT PRIMARY KEY, -- att_<uuid>
      delivery_id TEXT NOT NULL REFERENCES deliveries (id),
      attempt_number INTEGER NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      error TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
   );

CREATE INDEX IF NOT EXISTS idx_attempts_delivery ON attempts (delivery_id);