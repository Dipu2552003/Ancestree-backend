CREATE TABLE merge_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_person_id   UUID        NOT NULL REFERENCES persons(id),
  merged_person_id      UUID        NOT NULL REFERENCES persons(id),
  initiated_by          UUID        NOT NULL REFERENCES users(id),
  confirmed_by          UUID        REFERENCES users(id),
  status                TEXT        NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','confirmed','rejected','reversed')),
  conflict_resolution   JSONB,
  merged_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
