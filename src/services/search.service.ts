import { query } from '../utils/db'
import { logger } from '../utils/logger'

export type SearchScope = 'own' | 'external' | 'all'

/**
 * Person search.
 *   - scope='own'      → persons inside the requester's own family
 *   - scope='external' → persons in OTHER families only
 *   - scope='all'      → persons in every family (default — global search)
 *
 * communityId (optional):
 *   When provided, results are restricted to that community AND the query
 *   always excludes the requester's own family (discovery mode). Public
 *   persons (community_id IS NULL) are never returned.
 *   When null, only public (community_id IS NULL) persons are searched.
 *
 * Results always carry `family_name` and `is_own_family`.
 */
export async function searchPersons(
  q: string,
  familyId: string,
  scope: SearchScope = 'all',
  communityId: string | null = null,
) {
  if (!q || q.trim().length < 2) {
    return { results: [] }
  }

  const term = q.trim()
  const fatherSubquery = `
     LEFT JOIN LATERAL (
       SELECT fp.full_name
       FROM   relationships fr
       JOIN   persons fp ON fp.id = fr.from_person_id AND fp.deleted_at IS NULL
       WHERE  fr.to_person_id = p.id AND fr.rel_type = 'PARENT_OF' AND fr.deleted_at IS NULL
       ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
       LIMIT 1
     ) father ON true`

  // ── Community-scoped search ────────────────────────────────────────────────
  // Within the walled garden, exclude the searcher's own family (discovery only).
  if (communityId) {
    const { rows } = await query(
      `SELECT p.id, p.full_name, p.birth_year, p.node_state, p.photo_url,
              p.native_village, p.current_city,
              f.name AS family_name,
              false  AS is_own_family,
              father.full_name AS father_name
       FROM   persons p
       JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
       ${fatherSubquery}
       WHERE  p.deleted_at IS NULL
         AND  p.community_id = $3
         AND  p.primary_family_id != $4
         AND  (p.full_name ILIKE $1 OR similarity(p.full_name, $2) > 0.2)
       ORDER  BY
         CASE WHEN lower(p.full_name) LIKE lower($1) THEN 0 ELSE 1 END,
         similarity(p.full_name, $2) DESC,
         length(p.full_name)
       LIMIT  15`,
      [`${term}%`, term, communityId, familyId],
    )
    logger.debug({ q: term, scope: 'community', communityId, results: rows.length }, 'search')
    return { results: rows }
  }

  // ── Public search (community_id IS NULL persons only) ─────────────────────
  const familyClause =
    scope === 'own'      ? 'AND p.primary_family_id =  $3' :
    scope === 'external' ? 'AND p.primary_family_id != $3' :
                           ''

  const { rows } = await query(
    `SELECT p.id, p.full_name, p.birth_year, p.node_state, p.photo_url,
            p.native_village, p.current_city,
            f.name AS family_name,
            (p.primary_family_id = $3) AS is_own_family,
            father.full_name AS father_name
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
     ${fatherSubquery}
     WHERE  p.deleted_at IS NULL
       AND  p.community_id IS NULL
       AND  f.visibility = 'public'
       ${familyClause}
       AND  (p.full_name ILIKE $1 OR similarity(p.full_name, $2) > 0.2)
     ORDER  BY
       (p.primary_family_id = $3) DESC,
       CASE WHEN lower(p.full_name) LIKE lower($1) THEN 0 ELSE 1 END,
       similarity(p.full_name, $2) DESC,
       length(p.full_name)
     LIMIT  15`,
    [`${term}%`, term, familyId],
  )

  logger.debug({ q: term, scope, results: rows.length }, 'search')
  return { results: rows }
}