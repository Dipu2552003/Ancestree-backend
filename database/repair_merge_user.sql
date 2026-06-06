-- repair_merge_user.sql
-- Run this against your Postgres database when a user ends up with no family
-- membership after a merge (they see "No family found for user" on login).
--
-- It does two things:
--   1. If the user's person_id points to a soft-deleted person (the merged/deleted
--      node), update it to the surviving canonical via merge_records.
--   2. Restore the user's family_members row to the canonical person's family.
--
-- Replace the UUID on line 14 with the affected user's id.

DO $$
DECLARE
  v_user_id  UUID := 'f83f2ec9-b4ad-4fab-8bbc-4420d6ef129b';  -- ← change this
  v_person_id UUID;
  v_family_id UUID;
BEGIN
  -- Step 1: if person_id points to a soft-deleted node, reroute to canonical
  SELECT u.person_id INTO v_person_id FROM users u WHERE u.id = v_user_id;

  IF v_person_id IS NOT NULL THEN
    -- Check if the current person is soft-deleted
    IF EXISTS (SELECT 1 FROM persons WHERE id = v_person_id AND deleted_at IS NOT NULL) THEN
      -- Find the canonical via merge_records
      UPDATE users
      SET person_id = mr.canonical_person_id
      FROM merge_records mr
      WHERE users.id        = v_user_id
        AND mr.merged_person_id = v_person_id
        AND mr.status           = 'confirmed';

      RAISE NOTICE 'Updated person_id to canonical via merge_records';
    END IF;
  END IF;

  -- Re-read person_id after possible update
  SELECT u.person_id INTO v_person_id FROM users u WHERE u.id = v_user_id;

  -- Step 2: add the user to their person's family (if not already there)
  SELECT p.primary_family_id INTO v_family_id
  FROM persons p
  JOIN families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
  WHERE p.id = v_person_id AND p.deleted_at IS NULL;

  IF v_family_id IS NULL THEN
    RAISE EXCEPTION 'Could not determine a valid family for user %. Check persons and families tables manually.', v_user_id;
  END IF;

  INSERT INTO family_members (family_id, user_id, role)
  VALUES (v_family_id, v_user_id, 'member')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'User % restored to family %', v_user_id, v_family_id;
END $$;
