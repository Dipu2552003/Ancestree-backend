import pool, { query } from '../utils/db'

export async function claimByToken(token: string, userId: string) {
  const { rows: [person] } = await query<{
    id: string; full_name: string; node_state: string
    claimed_by: string | null; primary_family_id: string; is_alive: boolean
  }>(
    `SELECT id, full_name, node_state, claimed_by, primary_family_id, is_alive
     FROM persons WHERE invite_token = $1 AND deleted_at IS NULL`,
    [token.toUpperCase()]
  )

  if (!person) throw { status: 404, message: 'Invalid or expired invite code' }
  if (person.node_state === 'claimed') throw { status: 409, message: 'This node has already been claimed' }
  if (person.claimed_by === userId) throw { status: 409, message: 'You already own this node' }

  const { rows: [alreadyMember] } = await query(
    `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [person.primary_family_id, userId]
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `UPDATE persons
       SET node_state = 'claimed', claimed_by = $1, invite_token = NULL, updated_at = NOW()
       WHERE id = $2`,
      [userId, person.id]
    )

    if (!alreadyMember) {
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'member')`,
        [person.primary_family_id, userId]
      )
    }

    await client.query('COMMIT')
    return { success: true, person_id: person.id, family_id: person.primary_family_id, full_name: person.full_name }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function lookupToken(token: string) {
  const { rows: [person] } = await query<{
    full_name: string; node_state: string; primary_family_id: string
    birth_year: number | null; photo_url: string | null
  }>(
    `SELECT p.full_name, p.node_state, p.primary_family_id, p.birth_year, p.photo_url,
            f.name AS family_name
     FROM persons p
     JOIN families f ON f.id = p.primary_family_id
     WHERE p.invite_token = $1 AND p.deleted_at IS NULL`,
    [token.toUpperCase()]
  )

  if (!person) throw { status: 404, message: 'Invalid or expired invite code' }
  if (person.node_state === 'claimed') throw { status: 409, message: 'This node has already been claimed' }

  return person
}
