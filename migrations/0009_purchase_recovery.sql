ALTER TABLE revenuecat_webhook_events ADD COLUMN store_transaction_id TEXT;

CREATE TABLE IF NOT EXISTS pending_refunds (
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_refunds_status ON pending_refunds(status, updated_at);

CREATE TABLE IF NOT EXISTS task_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  client_request_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed')) DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, client_request_id)
);
