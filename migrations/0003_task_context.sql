ALTER TABLE tasks ADD COLUMN pet_id TEXT;
ALTER TABLE tasks ADD COLUMN photo_id TEXT;
ALTER TABLE tasks ADD COLUMN template_title TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_pet ON tasks(pet_id, created_at DESC);
