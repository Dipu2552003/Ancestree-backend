import { query } from '../utils/db'

export async function searchPersons(q: string, familyId: string) {
  if (!q || q.trim().length === 0) return { results: [] }

  const { rows } = await query(
    `SELECT id, full_name, birth_year, death_year, is_alive, node_state, photo_url
     FROM persons
     WHERE primary_family_id = $1
       AND deleted_at IS NULL
       AND similarity(full_name, $2) > 0.3
     ORDER BY similarity(full_name, $2) DESC
     LIMIT 10`,
    [familyId, q.trim()]
  )
  return { results: rows }
}
