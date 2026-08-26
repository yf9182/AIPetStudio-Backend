ALTER TABLE pets ADD COLUMN default_photo_id TEXT;
ALTER TABLE pets ADD COLUMN last_used_at TEXT;

ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN client_request_id TEXT;

ALTER TABLE artworks ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pet_photos (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO pet_photos(id, pet_id, user_id, object_key, is_default, created_at)
SELECT lower(hex(randomblob(16))), id, user_id, photo_key, 1, created_at
FROM pets
WHERE photo_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pet_photos WHERE pet_id = pets.id AND deleted_at IS NULL);

UPDATE pets
SET default_photo_id = (SELECT id FROM pet_photos WHERE pet_id = pets.id AND is_default = 1 AND deleted_at IS NULL LIMIT 1)
WHERE default_photo_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request
  ON tasks(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pet_photos_pet
  ON pet_photos(pet_id, deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_active
  ON tasks(user_id, state, updated_at);
