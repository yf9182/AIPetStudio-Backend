-- Store the exact Material Hub configuration supplied by the App at creation
-- time. The Worker must not fetch or re-resolve Material Hub records while a
-- task is being submitted, retried, or polled.
ALTER TABLE tasks ADD COLUMN material_snapshot_json TEXT NOT NULL DEFAULT '{}';

-- Existing tasks predate the snapshot contract. They remain queryable; their
-- retry path will fail safely and refund rather than using a live catalog.
