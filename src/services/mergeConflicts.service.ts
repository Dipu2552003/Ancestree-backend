/**
 * MERGE CONFLICT DETECTION
 *
 * Each detector is a pure async function that appends to an output array.
 * Adding a new conflict type = add a new detector function and call it in
 * detectMergeConflicts().  No other file needs to change.
 *
 * Current types detected (Option B — flag, don't block):
 *   double_parent          Person ended up with 2+ parents of the same gender
 *   double_spouse          Canonical now has multiple spouses after merge
 *   parent_sibling_paradox Two people are simultaneously parent-child AND siblings
 *   cycle                  A→B→…→A ancestry loop
 *   secondary_duplicate    A transferred node shares a name with an existing node
 *   claimed_orphan         A real user's node was deleted but couldn't be transferred
 *
 * Resolution options are reserved for future Option C (conflict-resolution UI).
 * Each conflict carries resolution_options: [] today — in the future each entry
 * will describe an API action (delete edge, reassign parent, etc.) the UI can
 * execute without re-merging.
 */

import { query } from '../utils/db'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConflictType =
  | 'double_parent'
  | 'double_spouse'
  | 'parent_sibling_paradox'
  | 'cycle'
  | 'secondary_duplicate'
  | 'claimed_orphan'

export interface ResolutionOption {
  id:          string   // unique key for this option
  label:       string   // human-readable label shown in future UI
  action_type: string   // e.g. 'delete_relationship' | 'reassign_parent'
  action_data: Record<string, string>  // parameters for the action
}

export interface MergeConflict {
  type:             ConflictType
  severity:         'warning' | 'error'
  message:          string
  affected_persons: string[]      // person IDs — frontend highlights these nodes
  // Empty today.  Future Option C will populate these so the resolution UI
  // can let the user pick an action without writing custom code per conflict.
  resolution_options: ResolutionOption[]
}

export interface ConflictContext {
  canonFamilyId:   string
  canonicalId:     string
  newPersonIds:    string[]   // all persons transferred from merged family
  newChildIds:     string[]   // new children of canonical after merge
  newSpouseIds:    string[]   // new spouses of canonical after merge
  orphanedUserId:  string | null  // set when a claimed user couldn't be transferred
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function detectMergeConflicts(
  ctx: ConflictContext,
): Promise<MergeConflict[]> {
  const out: MergeConflict[] = []

  // Run all detectors in parallel — each is read-only and independent.
  await Promise.all([
    detectDoubleParent(ctx, out),
    detectDoubleSpouse(ctx, out),
    detectParentSiblingParadox(ctx, out),
    detectCycle(ctx, out),
    detectSecondaryDuplicate(ctx, out),
    detectClaimedOrphan(ctx, out),
  ])

  return out
}

// ── Detector 1 — Double Parent ────────────────────────────────────────────────
// Three independent checks, each covering a gap the others miss:
//
//   Check A — Total parents > 2 for any node in scope.
//             Biologically impossible regardless of gender.
//
//   Check B — Two or more parents of the SAME known gender for any node.
//             Covers: Ghewar(male) + Jayanti(male) → both 'male', caught.
//             Requires gender IS NOT NULL so null-gender parents don't share
//             a bucket and silently pass.
//
//   Check C — Canonical specifically gained a new parent through this merge
//             while it already had one.  Catches the case where one parent's
//             gender is NULL (e.g. Ghewar=male, Jayanti=null) so checks A & B
//             both miss it, yet two separate people claim to be the parent.
//
// The 'seen' set deduplicates child_ids so the same node is not flagged twice.
async function detectDoubleParent(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  const scope = [ctx.canonicalId, ...ctx.newPersonIds]
  const seen  = new Set<string>()

  // ── Check A: total parents > 2 ──────────────────────────────────────────
  const { rows: tooMany } = await query<{
    child_id:   string
    cnt:        string
    parent_ids: string[]
  }>(
    `SELECT r.to_person_id        AS child_id,
            COUNT(*)::text        AS cnt,
            array_agg(r.from_person_id) AS parent_ids
     FROM   relationships r
     WHERE  r.primary_family_id = $1
       AND  r.rel_type          = 'PARENT_OF'
       AND  r.deleted_at        IS NULL
       AND  r.to_person_id      = ANY($2::uuid[])
     GROUP  BY r.to_person_id
     HAVING COUNT(*) > 2`,
    [ctx.canonFamilyId, scope],
  )

  for (const row of tooMany) {
    seen.add(row.child_id)
    out.push({
      type:             'double_parent',
      severity:         'error',
      message:          `A person now has ${row.cnt} parents — biologically impossible. Extra parent edges must be removed.`,
      affected_persons: [row.child_id, ...row.parent_ids],
      resolution_options: [],
    })
  }

  // ── Check B: 2+ parents of the same known gender ────────────────────────
  const { rows: sameGender } = await query<{
    child_id:   string
    gender:     string
    cnt:        string
    parent_ids: string[]
  }>(
    `SELECT r.to_person_id        AS child_id,
            p.gender,
            COUNT(*)::text        AS cnt,
            array_agg(p.id)       AS parent_ids
     FROM   relationships r
     JOIN   persons p
              ON  p.id         = r.from_person_id
              AND p.deleted_at IS NULL
              AND p.gender     IS NOT NULL
     WHERE  r.primary_family_id = $1
       AND  r.rel_type          = 'PARENT_OF'
       AND  r.deleted_at        IS NULL
       AND  r.to_person_id      = ANY($2::uuid[])
     GROUP  BY r.to_person_id, p.gender
     HAVING COUNT(*) > 1`,
    [ctx.canonFamilyId, scope],
  )

  for (const row of sameGender) {
    if (seen.has(row.child_id)) continue
    seen.add(row.child_id)
    const label = row.gender === 'male' ? 'fathers' : 'mothers'
    out.push({
      type:             'double_parent',
      severity:         'error',
      message:          `A person now has ${row.cnt} ${label}. Only one is biologically correct — the extra parent edge should be deleted.`,
      affected_persons: [row.child_id, ...row.parent_ids],
      resolution_options: [],
    })
  }

  // ── Check C: canonical gained a new parent while already having one ──────
  // Handles the Ghewar(male) + Jayanti(null-gender) case that A and B both
  // miss: total = 2 (not > 2) and genders differ (no same-gender bucket).
  // We know exactly which parents are "new" because they're in ctx.newPersonIds.
  if (!seen.has(ctx.canonicalId)) {
    const { rows: canonParents } = await query<{ parent_id: string }>(
      `SELECT from_person_id AS parent_id
       FROM   relationships
       WHERE  to_person_id      = $1
         AND  rel_type          = 'PARENT_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL`,
      [ctx.canonicalId, ctx.canonFamilyId],
    )

    const allParentIds    = canonParents.map(r => r.parent_id)
    const newParentIds    = allParentIds.filter(id => ctx.newPersonIds.includes(id))
    const existingParentIds = allParentIds.filter(id => !ctx.newPersonIds.includes(id))

    if (newParentIds.length > 0 && existingParentIds.length > 0) {
      out.push({
        type:             'double_parent',
        severity:         'error',
        message:          `This person already had a parent in the family tree, but the merge connected a second person as their parent too. Only one is correct — the extra parent edge should be removed.`,
        affected_persons: [ctx.canonicalId, ...allParentIds],
        resolution_options: [],
      })
    }
  }
}

// ── Detector 2 — Double Spouse ────────────────────────────────────────────────
// The canonical node had an existing spouse AND the merge brought a new spouse.
// Could be valid (remarriage) or a data conflict — flagged as warning for human review.
async function detectDoubleSpouse(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  if (ctx.newSpouseIds.length === 0) return

  // Find spouses of canonical that are NOT among the new ones (i.e. pre-existed the merge)
  const { rows } = await query<{ spouse_id: string }>(
    `SELECT CASE
       WHEN from_person_id = $1 THEN to_person_id
       ELSE from_person_id
     END AS spouse_id
     FROM relationships
     WHERE (from_person_id = $1 OR to_person_id = $1)
       AND rel_type          = 'SPOUSE_OF'
       AND primary_family_id = $2
       AND deleted_at        IS NULL
       AND CASE
         WHEN from_person_id = $1 THEN to_person_id
         ELSE from_person_id
       END != ALL($3::uuid[])`,
    [ctx.canonicalId, ctx.canonFamilyId, ctx.newSpouseIds],
  )

  if (rows.length > 0) {
    out.push({
      type:             'double_spouse',
      severity:         'warning',
      message:          'The merged person now has multiple spouses recorded. If this represents a remarriage it may be correct; otherwise one of the spouse relationships should be removed.',
      affected_persons: [ctx.canonicalId, ...rows.map(r => r.spouse_id), ...ctx.newSpouseIds],
      resolution_options: [],
    })
  }
}

// ── Detector 3 — Parent-Sibling Paradox ──────────────────────────────────────
// Two persons are connected by both PARENT_OF and SIBLING_OF — a structural
// impossibility.  Typically caused when one family recorded the wrong direction.
async function detectParentSiblingParadox(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  const scope = [ctx.canonicalId, ...ctx.newPersonIds]

  const { rows } = await query<{ a: string; b: string }>(
    `SELECT DISTINCT
            LEAST(r1.from_person_id, r1.to_person_id)   AS a,
            GREATEST(r1.from_person_id, r1.to_person_id) AS b
     FROM   relationships r1
     JOIN   relationships r2
              ON  (   (r2.from_person_id = r1.from_person_id AND r2.to_person_id = r1.to_person_id)
                   OR (r2.from_person_id = r1.to_person_id   AND r2.to_person_id = r1.from_person_id))
              AND r2.rel_type   = 'SIBLING_OF'
              AND r2.deleted_at IS NULL
     WHERE  r1.rel_type          = 'PARENT_OF'
       AND  r1.primary_family_id = $1
       AND  r1.deleted_at        IS NULL
       AND  (r1.from_person_id = ANY($2::uuid[]) OR r1.to_person_id = ANY($2::uuid[]))`,
    [ctx.canonFamilyId, scope],
  )

  for (const row of rows) {
    out.push({
      type:             'parent_sibling_paradox',
      severity:         'error',
      message:          'Two people are recorded as both parent-child and siblings simultaneously. One of these relationships is incorrect and must be removed.',
      affected_persons: [row.a, row.b],
      resolution_options: [],
    })
  }
}

// ── Detector 4 — Cycle ────────────────────────────────────────────────────────
// A person is their own ancestor — e.g. A→B→C→A.  Caused when one family had
// the generational direction reversed.  Depth is capped at 20 to keep the query
// bounded; real family trees never legitimately exceed that depth.
async function detectCycle(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  const scope = [ctx.canonicalId, ...ctx.newPersonIds]

  const { rows } = await query<{ ancestor: string; descendant: string }>(
    `WITH RECURSIVE ancestry(ancestor, descendant, path, cycle) AS (
       -- seed: edges that touch any node involved in this merge
       SELECT from_person_id,
              to_person_id,
              ARRAY[from_person_id],
              FALSE
       FROM   relationships
       WHERE  rel_type          = 'PARENT_OF'
         AND  primary_family_id = $1
         AND  deleted_at        IS NULL
         AND  (from_person_id = ANY($2::uuid[]) OR to_person_id = ANY($2::uuid[]))

       UNION ALL

       -- walk upward: follow further PARENT_OF edges
       SELECT r.from_person_id,
              a.descendant,
              a.path || r.from_person_id,
              r.from_person_id = ANY(a.path)
       FROM   relationships r
       JOIN   ancestry a ON r.to_person_id = a.ancestor
       WHERE  r.rel_type          = 'PARENT_OF'
         AND  r.primary_family_id = $1
         AND  r.deleted_at        IS NULL
         AND  NOT a.cycle
         AND  array_length(a.path, 1) < 20
     )
     SELECT DISTINCT ancestor, descendant
     FROM   ancestry
     WHERE  cycle
     LIMIT  10`,
    [ctx.canonFamilyId, scope],
  )

  for (const row of rows) {
    out.push({
      type:             'cycle',
      severity:         'error',
      message:          'A circular ancestry was detected: a person appears as both an ancestor and a descendant of the same person. The family tree cannot be rendered correctly until this loop is broken.',
      affected_persons: [row.ancestor, row.descendant],
      resolution_options: [],
    })
  }
}

// ── Detector 5 — Secondary Duplicate ─────────────────────────────────────────
// A person transferred from the merged family shares an exact name (case-insensitive)
// with an existing person in the canonical family.  They may be the same real
// person and need a follow-up merge.
async function detectSecondaryDuplicate(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  if (ctx.newPersonIds.length === 0) return

  const { rows } = await query<{
    existing_id: string
    new_id:      string
    full_name:   string
  }>(
    `SELECT p1.id         AS existing_id,
            p2.id         AS new_id,
            p1.full_name
     FROM   persons p1
     JOIN   persons p2
              ON  LOWER(p2.full_name) = LOWER(p1.full_name)
              AND p2.id               != p1.id
              AND p2.deleted_at       IS NULL
              AND p2.id               = ANY($1::uuid[])
     WHERE  p1.primary_family_id = $2
       AND  p1.deleted_at        IS NULL
       AND  p1.id                != ALL($1::uuid[])`,
    [ctx.newPersonIds, ctx.canonFamilyId],
  )

  for (const row of rows) {
    out.push({
      type:             'secondary_duplicate',
      severity:         'warning',
      message:          `"${row.full_name}" now appears twice in the family tree. They may be the same person (send another merge request) or genuinely different people who share a name.`,
      affected_persons: [row.existing_id, row.new_id],
      resolution_options: [],
    })
  }
}

// ── Detector 6 — Claimed Orphan ───────────────────────────────────────────────
// The deleted node was claimed by a real user, but the canonical was also already
// claimed — so the claimant's ownership could not be transferred.  They are now
// pointing at a soft-deleted node and cannot access their family tree.
async function detectClaimedOrphan(
  ctx: ConflictContext,
  out: MergeConflict[],
): Promise<void> {
  if (!ctx.orphanedUserId) return

  out.push({
    type:             'claimed_orphan',
    severity:         'error',
    message:          'A registered user\'s profile node was merged and deleted, but the canonical node was already claimed by another account. The affected user needs manual reassignment to the correct node.',
    affected_persons: [],
    resolution_options: [],
  })
}
