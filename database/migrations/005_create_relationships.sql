CREATE TABLE relationships (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_family_id UUID        NOT NULL REFERENCES families(id),
  from_person_id    UUID        NOT NULL REFERENCES persons(id),
  to_person_id      UUID        NOT NULL REFERENCES persons(id),
  rel_type          TEXT        NOT NULL
                    CHECK (rel_type IN ('PARENT_OF', 'SPOUSE_OF', 'SIBLING_OF')),
  sub_type          TEXT        DEFAULT 'biological',
  is_active         BOOLEAN     DEFAULT TRUE,
  union_year        INTEGER,
  union_place       TEXT,
  separation_year   INTEGER,
  union_order       INTEGER     DEFAULT 1,
  notes             TEXT,
  created_by        UUID        NOT NULL REFERENCES users(id),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
