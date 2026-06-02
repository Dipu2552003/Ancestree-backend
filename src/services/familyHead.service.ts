import { query } from '../utils/db'

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

  await query(
    `UPDATE families
     SET head_person_id = $1,
         name           = $2,
         updated_at     = NOW()
     WHERE id = $3`,
    [head.id, familyName, familyId],
  )
}
