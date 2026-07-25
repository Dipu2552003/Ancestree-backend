-- Per-community option catalogs for constrained ("enum") fields — moves the
-- hardcoded gotra / village lists out of the frontend bundle into the DB, so
-- each community owns (and can grow) its own lists. One row per option.
--
--   value = canonical value stored on persons (Hindi) and matched by search
--   label = optional English display label (the canonical stays `value`)
--
-- The per-community FIELD CONFIG (which fields are enum vs constant/auto-fill)
-- lives separately in communities.settings->'fields' (no schema change needed).
CREATE TABLE community_field_options (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  field_key    TEXT        NOT NULL,            -- 'gotra' | 'native_village'
  value        TEXT        NOT NULL,            -- canonical (Hindi)
  label        TEXT,                            -- English display label (optional)
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (community_id, field_key, value)
);

-- Hot path: "give me the active options for this community's field".
CREATE INDEX idx_cfo_lookup ON community_field_options (community_id, field_key) WHERE active;
