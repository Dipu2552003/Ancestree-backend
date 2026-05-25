CREATE TABLE persons (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_code           TEXT        NOT NULL UNIQUE,
  primary_family_id     UUID        NOT NULL REFERENCES families(id),

  full_name             TEXT        NOT NULL,
  first_name            TEXT,
  middle_name           TEXT,
  last_name             TEXT,
  name_native           TEXT,
  nickname              TEXT,

  gender                TEXT        CHECK (gender IN ('male','female','other','unknown')),
  gotra                 TEXT,
  religion              TEXT        DEFAULT 'Hindu',

  birth_date            DATE,
  birth_year            INTEGER,
  birth_place           TEXT,
  is_alive              BOOLEAN     NOT NULL DEFAULT TRUE,
  death_date            DATE,
  death_year            INTEGER,
  death_place           TEXT,

  phone                 TEXT,
  whatsapp              TEXT,
  email                 TEXT,

  current_address       TEXT,
  current_city          TEXT,
  current_state         TEXT,
  current_country       TEXT        DEFAULT 'India',
  current_pincode       TEXT,

  native_village        TEXT,
  native_tehsil         TEXT,
  native_district       TEXT,
  native_state          TEXT,
  native_country        TEXT        DEFAULT 'India',

  bio                   TEXT,
  occupation            TEXT,
  occupation_detail     TEXT,
  education             TEXT,

  photo_url             TEXT,
  photo_thumbnail_url   TEXT,

  node_state            TEXT        NOT NULL DEFAULT 'proxy'
                        CHECK (node_state IN ('proxy', 'invited', 'claimed')),
  is_placeholder        BOOLEAN     DEFAULT FALSE,
  claimed_by            UUID        REFERENCES users(id),
  created_by            UUID        NOT NULL REFERENCES users(id),
  steward_ids           UUID[]      DEFAULT '{}',

  invite_email          TEXT,
  invite_sent_at        TIMESTAMPTZ,
  invite_eligible_from  INTEGER,

  visibility            TEXT        NOT NULL DEFAULT 'family'
                        CHECK (visibility IN ('private', 'family', 'public')),

  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
