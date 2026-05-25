CREATE TABLE family_members (
  family_id         UUID        NOT NULL REFERENCES families(id),
  user_id           UUID        NOT NULL REFERENCES users(id),
  role              TEXT        NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member', 'viewer')),
  joined_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (family_id, user_id)
);
