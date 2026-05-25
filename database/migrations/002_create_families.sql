CREATE TABLE families (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  name_prefix       TEXT        NOT NULL UNIQUE,
  description       TEXT,
  created_by        UUID        NOT NULL REFERENCES users(id),
  visibility        TEXT        NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'family', 'public')),
  share_token       TEXT        UNIQUE DEFAULT encode(gen_random_bytes(24), 'base64url'),
  person_code_seq   INTEGER     NOT NULL DEFAULT 1,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
