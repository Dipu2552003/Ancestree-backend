-- Enforce a strict 1:1 mapping between users and person nodes at the DB level.
-- Until now this was only guaranteed by app logic in claimByToken/signupViaInvite;
-- these constraints make double-ownership impossible even under a race or a bug.
--
--   1. One node per user  — a user can be claimed_by at most one active person.
--      Scoped to deleted_at IS NULL so a user whose node was soft-deleted can
--      still claim a fresh one (matches the claimByToken re-claim guard).
--   2. One user per node  — at most one user row may point at a given person.
--
-- Together they guarantee: one person owns exactly one node, one node is owned
-- by exactly one person.

CREATE UNIQUE INDEX IF NOT EXISTS uq_persons_claimed_by
  ON persons (claimed_by)
  WHERE claimed_by IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_person_id
  ON users (person_id)
  WHERE person_id IS NOT NULL;
