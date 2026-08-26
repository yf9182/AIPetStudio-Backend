-- AI Pet Studio v1 contract rebuild.
-- This migration keeps users, credit_ledger, artworks and existing R2 objects,
-- but removes the legacy cloud-pet tables and pet columns from tasks.
PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS pet_photos;
DROP TABLE IF EXISTS pets;

CREATE TABLE tasks_v1 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL,
  template_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
  state TEXT NOT NULL,
  points INTEGER NOT NULL,
  debit_key TEXT NOT NULL UNIQUE,
  refund_key TEXT,
  provider_task_id TEXT,
  artwork_id TEXT,
  input_json TEXT NOT NULL DEFAULT '[]',
  output_key TEXT,
  error_code TEXT,
  error_message TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO tasks_v1 (
  id, user_id, template_id, template_title, kind, state, points, debit_key,
  refund_key, provider_task_id, artwork_id, input_json, output_key, error_code,
  error_message, progress, retry_count, client_request_id, created_at, updated_at
)
SELECT
  id, user_id, template_id, COALESCE(template_title, template_id), kind, state,
  points, debit_key, refund_key, provider_task_id, artwork_id, input_json,
  output_key, error_code, error_message, progress, retry_count,
  client_request_id, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_v1 RENAME TO tasks;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request
  ON tasks(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_user
  ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_active
  ON tasks(user_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_artworks_user
  ON artworks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user
  ON credit_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_id TEXT,
  virtual_currency_transaction_id TEXT,
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revenuecat_events_customer
  ON revenuecat_webhook_events(customer_id, created_at DESC);

PRAGMA foreign_keys = ON;
