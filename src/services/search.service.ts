import { query } from '../utils/db'
import { logger } from '../utils/logger'

export type SearchScope = 'own' | 'external' | 'all'

/**
 * Person search.
 *   - scope='own'      → persons inside the requester's own family
 *   - scope='external' → persons in OTHER families only
 *   - scope='all'      → persons in every family (default — global search)
 *
 * Results always carry `family_name` and `is_own_family` so the caller can
 * highlight or filter own-family vs external matches.
 */
export async function searchPersons(q: string, familyId: string, scope: SearchScope = 'all') {
  if (!q || q.trim().length < 2) {
    return { results: [] }
  }

  const term = q.trim()
  const familyClause =
    scope === 'own'      ? 'AND p.primary_family_id =  $3' :
    scope === 'external' ? 'AND p.primary_family_id != $3' :
                           '' // 'all' — no family filter

  const { rows } = await query(
    `SELECT p.id,
            p.full_name,
            p.birth_year,
            p.node_state,
            p.photo_url,
            p.native_village,
            p.current_city,
            f.name AS family_name,
            (p.primary_family_id = $3) AS is_own_family,
            father.full_name AS father_name
     FROM persons p
     JOIN families f
       ON f.id = p.primary_family_id
      AND f.deleted_at IS NULL
     LEFT JOIN LATERAL (
       -- Pick the male PARENT_OF parent as "father". When the parent's gender
       -- is unrecorded, fall back to the first non-deleted parent so users
       -- with partial data still see something useful.
       SELECT fp.full_name
       FROM   relationships fr
       JOIN   persons fp
         ON   fp.id = fr.from_person_id
        AND   fp.deleted_at IS NULL
       WHERE  fr.to_person_id = p.id
         AND  fr.rel_type     = 'PARENT_OF'
         AND  fr.deleted_at IS NULL
       ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
       LIMIT 1
     ) father ON true
     WHERE p.deleted_at IS NULL
       ${familyClause}
       AND (
            p.full_name ILIKE $1
            OR similarity(p.full_name, $2) > 0.2
       )
     ORDER BY
       -- Own-family matches first (graph navigation is the most common case)
       (p.primary_family_id = $3) DESC,
       CASE
         WHEN lower(p.full_name) LIKE lower($1) THEN 0
         ELSE 1
       END,
       similarity(p.full_name, $2) DESC,
       length(p.full_name)
     LIMIT 15`,
    [`${term}%`, term, familyId],
  )

  logger.debug({ q: term, scope, results: rows.length }, 'search')
  return { results: rows }
}