-- Enforce a strict 1:1 mapping between users and person nodes at the DB level.
-- Until now this was only guaranteed by app logic in claimByToken/signupViaInvite;
-- these constraints make double-ownership impossible even under a race or a bug.
--
--   1. One node per user  — a user can be claimed_by at most one active person.
--      Scoped to deleted_at IS NULL so a user whose node was soft-deleted can
--      still claim a fresh one (matches the claimByToken re-claim guard).
--   2. One user per node  — at most one user row may point at a given person.
--
-- IMPORTANT: this migration is intentionally NON-FATAL. If the existing data
-- already violates one of these rules (e.g. an account that claimed two nodes
-- before this constraint existed), building the unique index would fail and,
-- because migrations run at startup, would take the whole server down. Instead
-- we only create each index when the data is already clean, and otherwise skip
-- it with a NOTICE. The offending rows are surfaced to admins via the community
-- "data health" check (scripts/check-owner-dupes.ts / the admin dashboard), and
-- a later migration can add the index once the duplicates are resolved.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT claimed_by
      FROM   persons
      WHERE  claimed_by IS NOT NULL AND deleted_at IS NULL
      GROUP  BY claimed_by
      HAVING COUNT(*) > 1
    ) d
  ) THEN
    RAISE WARNING 'Skipping uq_persons_claimed_by: some accounts already own more than one active node. Resolve via the admin data-health check, then re-add the index.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_persons_claimed_by
      ON persons (claimed_by)
      WHERE claimed_by IS NOT NULL AND deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT person_id
      FROM   users
      WHERE  person_id IS NOT NULL
      GROUP  BY person_id
      HAVING COUNT(*) > 1
    ) d
  ) THEN
    RAISE WARNING 'Skipping uq_users_person_id: some person nodes are linked by more than one account. Resolve via the admin data-health check, then re-add the index.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_person_id
      ON users (person_id)
      WHERE person_id IS NOT NULL;
  END IF;
END $$;
