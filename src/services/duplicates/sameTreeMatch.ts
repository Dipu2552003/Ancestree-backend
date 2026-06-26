// Same-tree duplicate detection.
//
// When a node is added, surface existing nodes IN THE SAME FAMILY that look
// like the same person, so the user can view them or send a merge request
// instead of creating a duplicate.
//
// Deliberately kept separate from the cross-family `searchDuplicates`
// (merge/search.ts) so this heuristic can evolve independently. Today it's a
// simple, compulsory case-insensitive full-name match; gotra and birth year
// only add confidence. Improve the scoring here later (nicknames, fuzzy names,
// shared relatives, …) without touching the add-node flow.

import { query } from '../../utils/db'

export interface SameTreeMatch {
  id:             string
  full_name:      string
  birth_year:     number | null
  gotra:          string | null
  gender:         string | null
  photo_url:      string | null
  /** First-recorded parent (prefers father) — light context in the modal. */
  father_name:    string | null
  match_score:    number
  matched_fields: string[]
}

export interface SameTreeMatchInput {
  fullName:   string
  gotra?:     string | null
  birthYear?: number | null
  gender?:    string | null
}

function norm(s: string | null | undefined) {
  return (s ?? '').trim().toLowerCase()
}

/**
 * Find existing people in the same family that may be the same person as the
 * one just added (identified by `excludePersonId`, which is left out).
 *
 * Name match is compulsory — only same-name candidates are fetched — so every
 * result is at least a name match. Gotra and birth year boost the score and
 * populate `matched_fields` for display.
 */
export async function findSameTreeDuplicates(
  input: SameTreeMatchInput,
  familyId: string,
  excludePersonId: string,
): Promise<SameTreeMatch[]> {
  if (!norm(input.fullName)) return []

  const { rows } = await query<{
    id: string; full_name: string; birth_year: number | null;
    gotra: string | null; gender: string | null; photo_url: string | null;
    father_name: string | null;
  }>(
    `SELECT p.id, p.full_name, p.birth_year, p.gotra, p.gender, p.photo_url,
            father.full_name AS father_name
     FROM   persons p
     LEFT JOIN LATERAL (
       SELECT fp.full_name
       FROM   relationships fr
       JOIN   persons fp ON fp.id = fr.from_person_id AND fp.deleted_at IS NULL
       WHERE  fr.to_person_id = p.id
         AND  fr.rel_type     = 'PARENT_OF'
         AND  fr.deleted_at IS NULL
       ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
       LIMIT 1
     ) father ON true
     WHERE  p.primary_family_id = $1
       AND  p.id              <> $2
       AND  p.deleted_at      IS NULL
       AND  LOWER(p.full_name) = LOWER($3)
     LIMIT  20`,
    [familyId, excludePersonId, input.fullName],
  )

  return rows
    .map(c => {
      let score = 50
      const matched = ['name']

      if (norm(input.gotra) && norm(c.gotra) && norm(c.gotra) === norm(input.gotra)) {
        score += 15
        matched.push('gotra')
      }
      if (input.birthYear && c.birth_year) {
        const diff = Math.abs(input.birthYear - c.birth_year)
        if (diff === 0)     { score += 30; matched.push('birth year') }
        else if (diff <= 2) { score += 15; matched.push('approx. birth year') }
      }
      if (input.gender && c.gender && input.gender === c.gender) score += 5

      return {
        id:             c.id,
        full_name:      c.full_name,
        birth_year:     c.birth_year,
        gotra:          c.gotra,
        gender:         c.gender,
        photo_url:      c.photo_url,
        father_name:    c.father_name,
        match_score:    score,
        matched_fields: matched,
      }
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5)
}
