-- Shared, reviewed pet vocalizations used by HUMAN_TO_PET. The files live in
-- a versioned private R2 prefix and are never removed with a user task.
CREATE TABLE IF NOT EXISTS pet_translator_sounds (
  id TEXT PRIMARY KEY,
  library_version TEXT NOT NULL,
  species TEXT NOT NULL CHECK(species IN ('cat', 'dog')),
  emotion TEXT NOT NULL CHECK(emotion IN (
    'happy', 'excited', 'affectionate', 'calm', 'curious',
    'play_invitation', 'attention_seeking', 'displeased', 'afraid', 'alert'
  )),
  intensity TEXT NOT NULL CHECK(intensity IN ('low', 'medium', 'high')),
  vocalization TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  duration_seconds REAL NOT NULL CHECK(duration_seconds >= 2 AND duration_seconds <= 5),
  mime_type TEXT NOT NULL CHECK(mime_type = 'audio/mpeg'),
  source_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_author TEXT NOT NULL,
  source_license TEXT NOT NULL CHECK(source_license IN ('CC0', 'Public Domain')),
  source_license_url TEXT NOT NULL,
  downloaded_at TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_version, id)
);

CREATE INDEX IF NOT EXISTS idx_pet_translator_sounds_selection
  ON pet_translator_sounds(library_version, species, emotion, review_status, intensity);
CREATE INDEX IF NOT EXISTS idx_pet_translator_sounds_review
  ON pet_translator_sounds(library_version, review_status);

ALTER TABLE pet_translation_tasks ADD COLUMN audio_source TEXT NOT NULL DEFAULT 'generated';
ALTER TABLE pet_translation_tasks ADD COLUMN sound_id TEXT;
ALTER TABLE pet_translation_tasks ADD COLUMN sound_library_version TEXT;
ALTER TABLE pet_translation_tasks ADD COLUMN sound_emotion TEXT;
ALTER TABLE pet_translation_tasks ADD COLUMN sound_intensity TEXT;
ALTER TABLE pet_translation_tasks ADD COLUMN sound_duration_seconds REAL;
