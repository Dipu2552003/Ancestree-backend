import { query } from '../utils/db'
import { withOperation, captureAndUpdate } from '../utils/audit'
import { logger } from '../utils/logger'

// ── Family head (per-person lineage head) ──────────────────────────────────────
//
// Separate from the cluster head above (families.head_person_id). Every person
// points at the topmost ancestor of their own PATRILINE via persons.family_head_id.
// See docs/core-concepts.md §3 for the definition. Counting DISTINCT family_head_id
// within a family = number of lineages in that cluster.

export interface FHPerson { id: string; gender: string | null; birth_year: number | null; person_code: string }
export interface FHRel { from_person_id: string; to_person_id: string; rel_type: string }

/**
 * Partition a family's persons into patrilines; return personId → familyHeadId.
 *
 * The rule (structural, patrilineal — mirrors the frontend familySideFilter):
 *   • union a child with its lineage parent: the MALE parent if one exists,
 *     otherwise its sole/female parent (single-mother case).
 *   • union sibling pairs (SIBLING_OF).
 *   • SPOUSE_OF is ignored — so a married-in wife stays in her own father's
 *     line, or is her own head when her father isn't in the tree.
 * Head of each lineage: male → earliest birth_year → lowest person_code.
 *
 * Pure and DB-free so it can be unit-tested (see scripts/test-family-heads.ts).
 */
export function computeFamilyHeads(persons: FHPerson[], rels: FHRel[]): Map<string, string> {
  const ids = new Set(persons.map(p => p.id))
  const gender = new Map(persons.map(p => [p.id, p.gender]))

  // ── union-find ──
  const parent = new Map<string, string>(persons.map(p => [p.id, p.id]))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Collect each child's parents (only edges fully inside this person set).
  const parentsOf = new Map<string, string[]>()
  for (const r of rels) {
    if (r.rel_type !== 'PARENT_OF') continue
    if (!ids.has(r.from_person_id) || !ids.has(r.to_person_id)) continue
    const a = parentsOf.get(r.to_person_id)
    if (a) a.push(r.from_person_id); else parentsOf.set(r.to_person_id, [r.from_person_id])
  }

  // A member with a lineage parent inside its component is not a lineage root.
  const hasLineageParent = new Set<string>()
  for (const [child, parents] of parentsOf) {
    const males = parents.filter(p => gender.get(p) === 'male')
    const lineageParents = males.length > 0 ? males : parents
    for (const lp of lineageParents) { union(child, lp); hasLineageParent.add(child) }
  }
  for (const r of rels) {
    if (r.rel_type !== 'SIBLING_OF') continue
    if (!ids.has(r.from_person_id) || !ids.has(r.to_person_id)) continue
    union(r.from_person_id, r.to_person_id)
  }

  // Group by component root.
  const components = new Map<string, string[]>()
  for (const p of persons) {
    const root = find(p.id)
    const a = components.get(root)
    if (a) a.push(p.id); else components.set(root, [p.id])
  }

  const byId = new Map(persons.map(p => [p.id, p]))
  const rank = (a: string, b: string): number => {
    const pa = byId.get(a)!, pb = byId.get(b)!
    const ma = pa.gender === 'male' ? 0 : 1, mb = pb.gender === 'male' ? 0 : 1
    if (ma !== mb) return ma - mb
    const ya = pa.birth_year ?? 99999, yb = pb.birth_year ?? 99999
    if (ya !== yb) return ya - yb
    return pa.person_code < pb.person_code ? -1 : pa.person_code > pb.person_code ? 1 : 0
  }

  const heads = new Map<string, string>()
  for (const members of components.values()) {
    let roots = members.filter(m => !hasLineageParent.has(m))
    if (roots.length === 0) roots = members // cycle guard (cycles are rejected elsewhere)
    roots.sort(rank)
    const head = roots[0]
    for (const m of members) heads.set(m, head)
  }
  return heads
}

/**
 * Recompute persons.family_head_id for every person in a family, in one pass.
 * Call this after any event that reshapes a patriline — PARENT_OF / SIBLING_OF
 * change, person add/delete, merge accept. NOT after SPOUSE_OF changes (a
 * spouse-add that cascades into PARENT_OF edges goes through the PARENT_OF path).
 */
export async function recomputeFamilyHeads(familyId: string): Promise<void> {
  const [{ rows: persons }, { rows: rels }] = await Promise.all([
    query<FHPerson>(
      `SELECT id, gender, birth_year, person_code
       FROM   persons
       WHERE  primary_family_id = $1 AND deleted_at IS NULL`,
      [familyId],
    ),
    query<FHRel>(
      `SELECT from_person_id, to_person_id, rel_type
       FROM   relationships
       WHERE  primary_family_id = $1 AND deleted_at IS NULL
         AND  rel_type IN ('PARENT_OF', 'SIBLING_OF')`,
      [familyId],
    ),
  ])
  if (persons.length === 0) return

  const heads = computeFamilyHeads(persons, rels)
  const pIds: string[] = []
  const headIds: string[] = []
  for (const p of persons) { pIds.push(p.id); headIds.push(heads.get(p.id) ?? p.id) }

  // Derived field — written directly (not via the audit writer): it is recomputed
  // on undo and never hand-edited. Only rows that actually change are touched.
  await query(
    `UPDATE persons p
     SET    family_head_id = v.head, updated_at = NOW()
     FROM   unnest($1::uuid[], $2::uuid[]) AS v(id, head)
     WHERE  p.id = v.id AND p.family_head_id IS DISTINCT FROM v.head`,
    [pIds, headIds],
  )
}

/**
 * Recompute BOTH heads for a family in one call: the CLUSTER head
 * (families.head_person_id + name) and every person's LINEAGE head
 * (persons.family_head_id). Use this at every structural-change trigger so the
 * two never drift apart. Both are cheap and skip-if-unchanged internally.
 */
export async function recomputeHeads(familyId: string): Promise<void> {
  await recomputeFamilyHead(familyId)
  await recomputeFamilyHeads(familyId)
}

// A pseudo-migration marker recorded in schema_migrations once the initial
// backfill succeeds, so it never re-runs on subsequent boots.
const BACKFILL_MARKER = '030_family_head_backfill'

/**
 * Populate family_head_id for every existing family exactly once — the automated
 * counterpart to `npm run backfill:family-heads`. Called on server startup after
 * migrations. Idempotent and self-guarding: it checks the marker first, and only
 * records the marker if every family succeeded (so a partial failure retries on
 * the next boot). Safe to run in the background — it never blocks startup.
 */
export async function backfillFamilyHeadsOnce(): Promise<void> {
  const { rows: done } = await query(
    `SELECT 1 FROM schema_migrations WHERE filename = $1`, [BACKFILL_MARKER],
  )
  if (done.length > 0) return

  const { rows: families } = await query<{ id: string }>(
    `SELECT id FROM families WHERE deleted_at IS NULL`,
  )
  let failed = 0
  for (const f of families) {
    try { await recomputeFamilyHeads(f.id) }
    catch (err) { failed++; logger.error({ err, familyId: f.id }, 'family-head backfill: family failed') }
  }

  if (failed === 0) {
    await query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [BACKFILL_MARKER],
    )
    logger.info({ families: families.length }, 'family-head backfill complete (run-once)')
  } else {
    logger.warn({ families: families.length, failed }, 'family-head backfill incomplete — will retry next boot')
  }
}

/**
 * Recomputes which person is the "head" of a family and updates families.name
 * and families.head_person_id accordingly.
 *
 * Algorithm (mirrors the frontend computeFamilyName rules):
 *   1. Start from all persons whose primary_family_id = familyId.
 *   2. Follow PARENT_OF edges upward recursively (recursive CTE) to collect
 *      every ancestor, even those belonging to other families (after a merge
 *      the topmost ancestor may live in the other family's row).
 *   3. Among that full ancestry set, find "roots": persons who have NO
 *      PARENT_OF edge pointing at them within the set.
 *   4. Among roots: prefer male gender, then earliest birth_year,
 *      then lowest person_code (stable tie-break).
 *   5. UPDATE families SET head_person_id = …, name = "FirstName Family".
 */
export async function recomputeFamilyHead(familyId: string): Promise<void> {
  const { rows: [head] } = await query<{
    id: string; first_name: string | null; full_name: string
  }>(
    `WITH RECURSIVE ancestry AS (
       -- seed: every non-deleted person in this family
       SELECT p.id, p.full_name, p.first_name, p.gender, p.birth_year, p.person_code
       FROM   persons p
       WHERE  p.primary_family_id = $1
         AND  p.deleted_at IS NULL

       UNION

       -- walk PARENT_OF edges upward (from_person_id is the parent)
       SELECT p2.id, p2.full_name, p2.first_name, p2.gender, p2.birth_year, p2.person_code
       FROM   ancestry a
       JOIN   relationships r
                ON  r.to_person_id   = a.id
                AND r.rel_type       = 'PARENT_OF'
                AND r.deleted_at IS NULL
       JOIN   persons p2
                ON  p2.id           = r.from_person_id
                AND p2.deleted_at IS NULL
     ),
     roots AS (
       -- a root has no PARENT_OF parent inside the ancestry set
       SELECT a.*
       FROM   ancestry a
       WHERE  NOT EXISTS (
         SELECT 1
         FROM   relationships r2
         JOIN   ancestry anc2 ON anc2.id = r2.from_person_id
         WHERE  r2.to_person_id = a.id
           AND  r2.rel_type     = 'PARENT_OF'
           AND  r2.deleted_at IS NULL
       )
     )
     SELECT id, first_name, full_name
     FROM   roots
     ORDER BY
       CASE WHEN gender = 'male' THEN 0 ELSE 1 END,
       birth_year  ASC NULLS LAST,
       person_code ASC
     LIMIT 1`,
    [familyId],
  )

  if (!head) return

  const rawName = (head.first_name ?? head.full_name ?? '').trim()
  const firstName = rawName.split(/\s+/)[0] ?? ''
  const familyName = firstName ? `${firstName} Family` : 'Family'

  // Skip the write (and the audit noise) when nothing would change.
  const { rows: [current] } = await query<{ head_person_id: string | null; name: string }>(
    `SELECT head_person_id, name FROM families WHERE id = $1`,
    [familyId],
  )
  if (current && current.head_person_id === head.id && current.name === familyName) return

  // System-driven recompute — no human actor.
  await withOperation(
    { action: 'family.update_head', actorId: null, familyId },
    op => captureAndUpdate(op, 'family',
      { sql: 'id = $1', params: [familyId] },
      { sql: 'head_person_id = $1, name = $2, updated_at = NOW()', params: [head.id, familyName] },
    ),
  )
}
