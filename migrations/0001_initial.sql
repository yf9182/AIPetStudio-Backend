CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  refresh_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT 'pet',
  photo_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artworks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  template_id TEXT NOT NULL,
  template_title TEXT NOT NULL,
  kind TEXT NOT NULL,
  output_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  share_rewarded_at TEXT
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pets_user ON pets(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artworks_user ON artworks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);
