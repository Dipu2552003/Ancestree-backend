import { query } from '../utils/db'

export async function searchPersons(q: string, _familyId: string) {
  if (!q || q.trim().length < 2) {
    return { results: [] }
  }

  const term = q.trim()

  const { rows } = await query(
    `SELECT p.id,
            p.full_name,
            p.birth_year,
            p.node_state,
            p.photo_url,
            f.name AS family_name
     FROM persons p
     JOIN families f
       ON f.id = p.primary_family_id
      AND f.deleted_at IS NULL
     WHERE p.deleted_at IS NULL
       AND (
            p.full_name ILIKE $1
            OR similarity(p.full_name, $2) > 0.2
       )
     ORDER BY
       CASE
         WHEN lower(p.full_name) LIKE lower($1) THEN 0
         ELSE 1
       END,
       similarity(p.full_name, $2) DESC,
       length(p.full_name)
     LIMIT 10`,
    [`${term}%`, term],
  )

  return { results: rows }
}