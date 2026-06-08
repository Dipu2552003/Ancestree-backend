-- Password reset support: short-lived single-use tokens stored as SHA-256 hashes
-- so a DB leak doesn't immediately compromise active reset links.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_reset_token_hash
  ON users (reset_token_hash)
  WHERE reset_token_hash IS NOT NULL;
