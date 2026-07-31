import { query } from '../utils/db'
import { logger } from '../utils/logger'

export type SearchScope = 'own' | 'external' | 'all'

/**
 * The three searchable family types. A family is exactly one of:
 *   - community → belongs to a community (community_id set); searchable only
 *                 within that community's trees.
 *   - private   → visibility='private', no community; searchable only within
 *                 its own tree.
 *   - public    → visibility='public', no community; searchable across all
 *                 other public family trees.
 */
export type CallerScope =
  | { kind: 'community'; communityId: string }
  | { kind: 'private' }
  | { kind: 'public' }

/**
 * Resolves the requester's family type so search can be scoped correctly.
 * The JWT only carries communityId, so visibility (public vs private) is read
 * from the families table. A community membership always wins.
 */
export async function resolveCallerScope(
  familyId: string,
  communityIdFromToken: string | null,
): Promise<CallerScope> {
  if (communityIdFromToken) return { kind: 'community', communityId: communityIdFromToken }

  const { rows: [fam] } = await query<{ visibility: string | null; community_id: string | null }>(
    `SELECT visibility, community_id FROM families WHERE id = $1 AND deleted_at IS NULL`,
    [familyId],
  )
  if (fam?.community_id) return { kind: 'community', communityId: fam.community_id }
  if (fam?.visibility === 'private') return { kind: 'private' }
  return { kind: 'public' }
}

// Resolves each person's father name (prefers a male PARENT_OF source) so search
// results can disambiguate same-named people. Shared by every search variant.
const FATHER_SUBQUERY = `
   LEFT JOIN LATERAL (
     SELECT fp.full_name
     FROM   relationships fr
     JOIN   persons fp ON fp.id = fr.from_person_id AND fp.deleted_at IS NULL
     WHERE  fr.to_person_id = p.id AND fr.rel_type = 'PARENT_OF' AND fr.deleted_at IS NULL
     ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
     LIMIT 1
   ) father ON true`

/**
 * Public, unauthenticated search for the landing page. Only persons in PUBLIC,
 * non-community families are returned — never private or community trees — so it
 * is safe to expose without a session. Mirrors the public branch of
 * searchPersons() but takes no familyId (there is no "own family" for a guest).
 */
export async function searchPublicPersons(q: string) {
  if (!q || q.trim().length < 2) {
    return { results: [] }
  }
  const term = q.trim()
  const { rows } = await query(
    `SELECT p.id, p.full_name, p.birth_year, p.node_state, p.photo_url,
            p.native_village, p.current_city,
            f.name AS family_name,
            false  AS is_own_family,
            father.full_name AS father_name
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
     ${FATHER_SUBQUERY}
     WHERE  p.deleted_at IS NULL
       AND  p.community_id IS NULL
       AND  f.visibility = 'public'
       AND  (p.full_name ILIKE $1 OR similarity(p.full_name, $2) > 0.2)
     ORDER  BY
       CASE WHEN lower(p.full_name) LIKE lower($1) THEN 0 ELSE 1 END,
       similarity(p.full_name, $2) DESC,
       length(p.full_name)
     LIMIT  15`,
    [`${term}%`, term],
  )
  logger.debug({ q: term, scope: 'public', results: rows.length }, 'public search')
  return { results: rows }
}

/**
 * Person search, scoped to the requester's family type (see CallerScope):
 *   - community → only persons within the requester's community trees
 *   - private   → only persons within the requester's own tree
 *   - public    → persons across all public family trees
 *
 * The `scope` param further narrows within that boundary (community/public only):
 *   - scope='own'      → persons inside the requester's own family
 *   - scope='external' → persons in OTHER families only
 *   - scope='all'      → no extra family restriction (default)
 * Private callers ignore `scope` — a private tree is always own-family only.
 *
 * communityId is the value from the requester's JWT (null for non-community
 * users); the real boundary is resolved via resolveCallerScope().
 *
 * Results always carry `family_name` and `is_own_family`.
 */
export async function searchPersons(
  q: string,
  familyId: string,
  scope: SearchScope = 'all',
  communityId: string | null = null,
  filters: { gender?: string; ageMin?: number; ageMax?: number } = {},
) {
  if (!q || q.trim().length < 2) {
    return { results: [] }
  }

  const term = q.trim()
  const caller = await resolveCallerScope(familyId, communityId)

  // Per-scope `scope` narrowing (community/public). Private is forced to own tree.
  const familyClause =
    scope === 'own'      ? 'AND p.primary_family_id =  $3' :
    scope === 'external' ? 'AND p.primary_family_id != $3' :
                           ''

  // Family-type boundary — the security-relevant filter. $1=term%, $2=term, $3=familyId.
  const params: (string | null)[] = [`${term}%`, term, familyId]
  let boundary: string
  if (caller.kind === 'community') {
    boundary = `AND p.community_id = $4 ${familyClause}`
    params.push(caller.communityId)
  } else if (caller.kind === 'private') {
    // A private tree is searchable only within itself.
    boundary = 'AND p.community_id IS NULL AND p.primary_family_id = $3'
  } else {
    boundary = `AND p.community_id IS NULL AND f.visibility = 'public' ${familyClause}`
  }

  // Optional refine filters (gender / age). Age → birth_year range; people with
  // an unknown birth_year are excluded once an age bound is set (can't place them).
  const refine: string[] = []
  if (filters.gender === 'male' || filters.gender === 'female') {
    params.push(filters.gender)
    refine.push(`AND p.gender = $${params.length}`)
  }
  const nowYear = new Date().getFullYear()
  if (filters.ageMin != null && Number.isFinite(filters.ageMin)) {
    params.push(String(nowYear - filters.ageMin))
    refine.push(`AND p.birth_year IS NOT NULL AND p.birth_year <= $${params.length}`)
  }
  if (filters.ageMax != null && Number.isFinite(filters.ageMax)) {
    params.push(String(nowYear - filters.ageMax))
    refine.push(`AND p.birth_year IS NOT NULL AND p.birth_year >= $${params.length}`)
  }

  const { rows } = await query(
    `SELECT p.id, p.full_name, p.birth_year, p.node_state, p.photo_url,
            p.native_village, p.current_city,
            f.name AS family_name,
            (p.primary_family_id = $3) AS is_own_family,
            father.full_name AS father_name
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
     ${FATHER_SUBQUERY}
     WHERE  p.deleted_at IS NULL
       ${boundary}
       ${refine.join('\n       ')}
       AND  (p.full_name ILIKE $1 OR similarity(p.full_name, $2) > 0.2)
     ORDER  BY
       (p.primary_family_id = $3) DESC,
       CASE WHEN lower(p.full_name) LIKE lower($1) THEN 0 ELSE 1 END,
       similarity(p.full_name, $2) DESC,
       length(p.full_name)
     LIMIT  15`,
    params,
  )

  logger.debug({ q: term, scope, kind: caller.kind, results: rows.length }, 'search')
  return { results: rows }
}

export type PersonFilters = {
  q?: string
  gender?: string
  gotra?: string
  village?: string
  city?: string
  age_min?: number
  age_max?: number
  /** 'married' | 'unmarried' — derived from active SPOUSE_OF relationships. */
  marital?: string
  education?: string
  occupation?: string
}

// Age from birth_date when known, else birth_year. NULL when neither is set.
const AGE_EXPR = `COALESCE(
  EXTRACT(YEAR FROM AGE(p.birth_date))::int,
  EXTRACT(YEAR FROM CURRENT_DATE)::int - p.birth_year
)`

/**
 * Community-wide person directory with optional filters ("Apna Parivar").
 * Unlike searchPersons() this lists everyone in the community when no
 * filters are given, and matches on structured fields rather than fuzzy name.
 */
export async function filterCommunityPersons(communityId: string, f: PersonFilters) {
  const where = ['p.deleted_at IS NULL', 'p.community_id = $1']
  const params: unknown[] = [communityId]
  const add = (clause: string, value: unknown) => {
    params.push(value)
    where.push(clause.replace(/\?/g, `$${params.length}`))
  }

  if (f.q) add('p.full_name ILIKE ?', `%${f.q}%`)
  if (f.gender) add('p.gender = ?', f.gender)
  if (f.gotra) add('p.gotra ILIKE ?', f.gotra)
  if (f.village) add('p.native_village ILIKE ?', f.village)
  if (f.city) add('(p.current_city ILIKE ? OR p.current_state ILIKE ? OR p.current_address ILIKE ?)', `%${f.city}%`)
  if (f.age_min !== undefined) add(`${AGE_EXPR} >= ?`, f.age_min)
  if (f.age_max !== undefined) add(`${AGE_EXPR} <= ?`, f.age_max)
  if (f.education)  add('p.education ILIKE ?', `%${f.education}%`)
  if (f.occupation) add('(p.occupation ILIKE ? OR p.occupation_detail ILIKE ?)', `%${f.occupation}%`)

  // Marital status is not a column — a person is "married" iff they have an
  // active (not soft-deleted, not separated) spouse link. This correlated
  // sub-query carries no bound params, so it's pushed onto WHERE directly.
  const SPOUSE_EXISTS =
    `EXISTS (SELECT 1 FROM relationships r
             WHERE  r.rel_type = 'SPOUSE_OF' AND r.deleted_at IS NULL AND r.is_active IS NOT FALSE
               AND  (r.from_person_id = p.id OR r.to_person_id = p.id))`
  if (f.marital === 'married')   where.push(SPOUSE_EXISTS)
  if (f.marital === 'unmarried') where.push(`NOT ${SPOUSE_EXISTS}`)

  const { rows } = await query(
    `SELECT p.id, p.full_name, p.gender, p.gotra, p.birth_year,
            ${AGE_EXPR} AS age,
            p.native_village, p.current_city, p.current_state,
            p.photo_url, p.node_state,
            f.name AS family_name,
            father.full_name AS father_name
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
     ${FATHER_SUBQUERY}
     WHERE  ${where.join('\n       AND ')}
     ORDER  BY p.full_name
     LIMIT  1000`,   // ponytail: covers the whole community for now; add keyset paging past ~1k
    params,
  )
  logger.debug({ communityId, filters: f, results: rows.length }, 'parivar filter')
  return { results: rows }
}