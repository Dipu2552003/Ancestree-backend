CREATE TABLE audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        REFERENCES families(id),
  actor_id      UUID        REFERENCES users(id),
  action        TEXT        NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     UUID        NOT NULL,
  before_state  JSONB,
  after_state   JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
