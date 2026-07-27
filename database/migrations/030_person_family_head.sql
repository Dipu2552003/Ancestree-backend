-- Family head: the topmost ancestor of each person's own patriline (lineage).
-- Distinct from families.head_person_id, which is the whole-cluster head.
-- See docs/core-concepts.md §3 for the definition and recompute triggers.
--
-- Derived data — set by recomputeFamilyHeads(), never hand-edited, excluded from
-- the audit trail. ON DELETE SET NULL so a hard-deleted head can never block the
-- delete; dependents are re-stamped on the next recompute, and the frontend
-- falls back to computeFamilyName while a value is null.
ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS family_head_id UUID
  REFERENCES persons(id) ON DELETE SET NULL;

-- Supports "count lineages in a cluster" and per-perspective head lookup.
CREATE INDEX IF NOT EXISTS idx_persons_family_head
  ON persons (primary_family_id, family_head_id);
