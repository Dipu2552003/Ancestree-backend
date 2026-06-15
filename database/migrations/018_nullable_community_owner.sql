-- Platform-admin-created communities have no user owner (created via admin key only).
-- Make owner_id nullable so community creation does not require a logged-in user.
ALTER TABLE communities ALTER COLUMN owner_id DROP NOT NULL;
