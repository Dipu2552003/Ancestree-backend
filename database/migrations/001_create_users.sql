CREATE TABLE users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        NOT NULL UNIQUE,
  display_name      TEXT,
  phone             TEXT,
  person_id         UUID,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ
);
