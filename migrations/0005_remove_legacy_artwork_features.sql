-- PetAI Studio current backend contract:
-- remove sharing/cancellation data while preserving users, credits, tasks and outputs.
PRAGMA foreign_keys = OFF;

DELETE FROM credit_ledger WHERE reason = 'share_reward';

CREATE TABLE tasks_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL,
  template_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'processing', 'succeeded', 'failed')),
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

INSERT INTO tasks_v2 (
  id, user_id, template_id, template_title, kind, state, points, debit_key,
  refund_key, provider_task_id, artwork_id, input_json, output_key, error_code,
  error_message, progress, retry_count, client_request_id, created_at, updated_at
)
SELECT
  id, user_id, template_id, COALESCE(template_title, template_id), kind,
  CASE WHEN state IN ('queued', 'processing', 'succeeded') THEN state ELSE 'failed' END,
  points, debit_key, refund_key, provider_task_id, artwork_id, input_json,
  output_key, error_code, error_message, progress, retry_count,
  client_request_id, created_at, updated_at
FROM tasks;

CREATE TABLE artworks_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks_v2(id),
  template_id TEXT NOT NULL,
  template_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video')),
  output_key TEXT NOT NULL,
  watermark INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO artworks_v2 (
  id, user_id, task_id, template_id, template_title, kind, output_key,
  watermark, created_at, deleted_at
)
SELECT
  id, user_id, task_id, template_id, template_title, kind, output_key,
  watermark, created_at, deleted_at
FROM artworks;

DROP TABLE artworks;
DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;
ALTER TABLE artworks_v2 RENAME TO artworks;

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

PRAGMA foreign_keys = ON;
