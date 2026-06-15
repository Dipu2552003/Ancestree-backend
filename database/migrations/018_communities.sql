-- Communities — walled-garden tenants (e.g. "Khandelwal Samaj")
CREATE TABLE communities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL UNIQUE,        -- URL-safe: khandelwal-samaj
  description   TEXT,
  owner_id      UUID        NOT NULL REFERENCES users(id),
  member_limit  INTEGER     NOT NULL DEFAULT 0,     -- 0 = unlimited
  settings      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Maps users to communities with a role
-- One user can belong to exactly one community (enforced at application layer)
CREATE TABLE community_members (
  community_id  UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  role          TEXT        NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);

-- One-time invite codes to join a community (separate from family-node invites)
CREATE TABLE community_invites (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  invited_email TEXT,
  invite_code   TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  role          TEXT        NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin', 'member')),
  created_by    UUID        NOT NULL REFERENCES users(id),
  used_by       UUID        REFERENCES users(id),
  used_at       TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Stamp each family with the community it was born into (immutable after creation)
ALTER TABLE families ADD COLUMN community_id UUID REFERENCES communities(id);

-- Stamp each person with the community they belong to (immutable after creation)
ALTER TABLE persons  ADD COLUMN community_id UUID REFERENCES communities(id);

-- Widen persons.visibility to include 'community'
ALTER TABLE persons DROP   CONSTRAINT IF EXISTS persons_visibility_check;
ALTER TABLE persons ADD    CONSTRAINT persons_visibility_check
  CHECK (visibility IN ('private', 'family', 'public', 'community'));

-- Data migration: existing non-community families were created before visibility
-- was enforced. They are public trees, so mark them as such now.
UPDATE families SET visibility = 'public' WHERE community_id IS NULL;

-- Performance indexes
CREATE INDEX idx_communities_slug       ON communities      (slug);
CREATE INDEX idx_families_community     ON families         (community_id) WHERE community_id IS NOT NULL;
CREATE INDEX idx_persons_community      ON persons          (community_id) WHERE community_id IS NOT NULL;
CREATE INDEX idx_community_members_uid  ON community_members(user_id);
CREATE INDEX idx_community_invites_code ON community_invites(invite_code);
