-- Email-ownership codes for community signup. One row per pending email;
-- re-requesting a code overwrites the previous one (upsert on email).
CREATE TABLE IF NOT EXISTS signup_verifications (
  email       TEXT        PRIMARY KEY,
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
