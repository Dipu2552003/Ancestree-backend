-- Community access levels (see docs/ACCESS_LEVELS.md).
-- A single global 5-level ladder; the level is stored per member here, the
-- definitions live in code. Default 2 = Family Editor.
--   0 Viewer · 1 Household · 2 Family Editor · 3 Admin · 4 Owner
ALTER TABLE community_members ADD COLUMN IF NOT EXISTS level smallint NOT NULL DEFAULT 2;

-- Backfill from the legacy role so existing members keep equivalent access.
UPDATE community_members
SET level = CASE role
              WHEN 'owner' THEN 4
              WHEN 'admin' THEN 3
              ELSE 2
            END;
