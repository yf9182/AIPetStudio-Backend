-- Pet Translator V1. Request records are retained as a minimal audit/idempotency
-- trail after result text and generated audio expire.
CREATE TABLE IF NOT EXISTS pet_translation_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('PET_TO_HUMAN', 'HUMAN_TO_PET')),
  species TEXT NOT NULL CHECK(species IN ('cat', 'dog')),
  language TEXT NOT NULL CHECK(language = 'zh-CN'),
  state TEXT NOT NULL CHECK(state IN ('reserved', 'processing', 'succeeded', 'failed', 'expired')),
  phase TEXT NOT NULL,
  credit_cost INTEGER NOT NULL,
  debit_key TEXT NOT NULL UNIQUE,
  debit_status TEXT NOT NULL CHECK(debit_status IN ('pending', 'confirmed', 'unknown', 'not_required')) DEFAULT 'pending',
  refund_status TEXT NOT NULL CHECK(refund_status IN ('none', 'pending', 'completed', 'manual_review')) DEFAULT 'none',
  input_mime_type TEXT NOT NULL,
  input_size INTEGER NOT NULL,
  input_duration_seconds REAL NOT NULL,
  result_json TEXT,
  output_key TEXT,
  error_code TEXT,
  error_message TEXT,
  gemini_model TEXT,
  gemini_latency_ms INTEGER,
  gemini_input_tokens INTEGER,
  gemini_output_tokens INTEGER,
  sound_model TEXT,
  sound_latency_ms INTEGER,
  sound_character_cost INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(user_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pet_translation_active_user
  ON pet_translation_tasks(user_id)
  WHERE state IN ('reserved', 'processing');
CREATE INDEX IF NOT EXISTS idx_pet_translation_user
  ON pet_translation_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pet_translation_expiry
  ON pet_translation_tasks(expires_at, state);
CREATE INDEX IF NOT EXISTS idx_pet_translation_rate
  ON pet_translation_tasks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pet_translation_recovery
  ON pet_translation_tasks(debit_status, refund_status, updated_at);
