// Operation 1 — duplicate-person search across all families except the caller's.
// Pure SQL candidate fetch + in-process scoring; no mutations.

import { query } from '../../utils/db'
import type { SearchInput, PotentialMatch } from './types'

interface DBCandidate {
  id:             string
  full_name:      string
  first_name:     string | null
  last_name:      string | null
  birth_year:     number | null
  native_village: string | null
  current_city:   string | null
  gotra:          string | null
  gender:         string | null
  photo_url:      string | null
  father_name:    string | null
  family_name:    string
  family_id:      string
  member_count:   number
}

function norm(s: string | null | undefined) {
  return (s ?? '').trim().toLowerCase()
}

function scoreCandidate(c: DBCandidate, input: SearchInput): { score: number; matched: string[] } {
  let score = 0
  const matched: string[] = []

  if (norm(c.full_name) === norm(input.fullName) && norm(input.fullName)) {
    score += 50
    matched.push('name')
  } else {
    if (norm(input.firstName) && norm(c.first_name) && norm(c.first_name) === norm(input.firstName)) {
      score += 20
      matched.push('first name')
    }
    if (norm(input.lastName) && norm(c.last_name) && norm(c.last_name) === norm(input.lastName)) {
      score += 15
      matched.push('last name')
    }
  }

  if (input.birthYear && c.birth_year) {
    const diff = Math.abs(input.birthYear - c.birth_year)
    if (diff === 0)      { score += 30; matched.push('birth year') }
    else if (diff <= 2)  { score += 15; matched.push('approx. birth year') }
  }

  if (norm(input.nativeVillage) && norm(c.native_village) && norm(c.native_village) === norm(input.nativeVillage)) {
    score += 20
    matched.push('village')
  }

  if (norm(input.gotra) && norm(c.gotra) && norm(c.gotra) === norm(input.gotra)) {
    score += 15
    matched.push('gotra')
  }

  if (input.gender && c.gender && input.gender === c.gender) score += 5

  return { score, matched }
}

/**
 * Multi-field scored search across all families except the caller's.
 * Matches on name, birth year, village, gotra — returns scored + ranked results.
 */
export async function searchDuplicates(
  input: SearchInput,
  callerFamilyId: string,
): Promise<PotentialMatch[]> {
  // Build OR conditions dynamically based on available fields
  const orConditions: string[] = []
  const params: (string | number)[] = [callerFamilyId]
  let idx = 2

  orConditions.push(`LOWER(p.full_name) = LOWER($${idx++})`)
  params.push(input.fullName)

  if (input.firstName?.trim()) {
    orConditions.push(`(p.first_name IS NOT NULL AND LOWER(p.first_name) = LOWER($${idx++}))`)
    params.push(input.firstName.trim())
  }

  if (input.lastName?.trim()) {
    orConditions.push(`(p.last_name IS NOT NULL AND LOWER(p.last_name) = LOWER($${idx++}))`)
    params.push(input.lastName.trim())
  }

  const { rows } = await query<DBCandidate>(
    `SELECT p.id, p.full_name, p.first_name, p.last_name,
            p.birth_year, p.native_village, p.current_city,
            p.gotra, p.gender, p.photo_url,
            f.name AS family_name, f.id AS family_id,
            father.full_name AS father_name,
            (SELECT COUNT(*) FROM family_members fm WHERE fm.family_id = f.id)::int AS member_count
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id
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
     WHERE  p.deleted_at        IS NULL
       AND  p.primary_family_id != $1
       AND  f.deleted_at        IS NULL
       AND  (${orConditions.join(' OR ')})
     LIMIT  30`,
    params,
  )

  return rows
    .map(c => {
      const { score, matched } = scoreCandidate(c, input)
      return {
        id:             c.id,
        full_name:      c.full_name,
        birth_year:     c.birth_year,
        native_village: c.native_village,
        current_city:   c.current_city,
        gotra:          c.gotra,
        gender:         c.gender,
        photo_url:      c.photo_url,
        father_name:    c.father_name,
        family_name:    c.family_name,
        family_id:      c.family_id,
        member_count:   c.member_count,
        match_score:    score,
        matched_fields: matched,
      }
    })
    .filter(m => m.match_score >= 20)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5)
}
