-- Homes — who physically lives together, independent of lineage/cluster.
-- Community-scoped for now (community_id NOT NULL). A home carries a location
-- (city for now; address columns can be added later) and a computed head_person_id
-- (the "home head", whose perspective opens when you click the home).
--
-- home_members is a plain many-to-many join (NO unique on person_id) so a person
-- CAN belong to multiple homes later. The "one home per person" rule is enforced
-- in the service layer for now (see community.service.ts), not the schema.
CREATE TABLE IF NOT EXISTS homes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name           TEXT,                                   -- optional label
  city           TEXT,                                   -- required at create time (the "address")
  state          TEXT,
  country        TEXT        DEFAULT 'India',
  head_person_id UUID        REFERENCES persons(id) ON DELETE SET NULL,
  created_by     UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS home_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id    UUID        NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  person_id  UUID        NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_homes_community     ON homes (community_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_home_members_home   ON home_members (home_id)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_home_members_person ON home_members (person_id)    WHERE deleted_at IS NULL;
