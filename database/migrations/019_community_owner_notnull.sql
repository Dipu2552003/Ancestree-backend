-- Community creation now requires an owner (signup happens atomically with community creation).
-- Restore NOT NULL on owner_id, which migration 018 had made nullable.
ALTER TABLE communities ALTER COLUMN owner_id SET NOT NULL;
