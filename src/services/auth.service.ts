import bcrypt from 'bcrypt'
import pool, { query } from '../utils/db'
import { signToken } from '../utils/jwt'
import { SignupInput, LoginInput } from '../schemas/auth.schema'
import { createNotification } from './notification.service'

function buildNamePrefix(displayName: string): string {
  const lastName = displayName.trim().split(' ').pop() ?? displayName
  return lastName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6).padEnd(3, 'X')
}

async function uniquePrefix(base: string): Promise<string> {
  const { rowCount } = await query('SELECT id FROM families WHERE name_prefix = $1', [base])
  if (!rowCount) return base
  const suffix = Math.floor(Math.random() * 900 + 100)
  return base.slice(0, 3) + suffix
}

export async function signup(input: SignupInput) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
  if ((existing.rowCount ?? 0) > 0) {
    throw { status: 409, message: 'Email already registered' }
  }

  const passwordHash = await bcrypt.hash(input.password, 10)
  const namePrefix = await uniquePrefix(buildNamePrefix(input.display_name))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [user] } = await client.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name`,
      [input.email, input.display_name, passwordHash]
    )

    const { rows: [family] } = await client.query<{ id: string }>(
      `INSERT INTO families (name, name_prefix, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${input.display_name}'s Family`, namePrefix, user.id]
    )

    await client.query(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [family.id, user.id]
    )

    const personCode = `${namePrefix}-001`
    const { rows: [person] } = await client.query<{ id: string }>(
      `INSERT INTO persons
         (person_code, primary_family_id, full_name, node_state, claimed_by, created_by, visibility)
       VALUES ($1, $2, $3, 'claimed', $4, $4, 'family')
       RETURNING id`,
      [personCode, family.id, input.display_name, user.id]
    )

    await client.query('UPDATE users SET person_id = $1 WHERE id = $2', [person.id, user.id])

    await client.query('COMMIT')

    const token = signToken({ userId: user.id, familyId: family.id })

    // Non-blocking: search for proxy nodes that match this user's name.
    // If found, send them a claim_suggestion notification so they can
    // request to join that family directly from the notification bell.
    sendClaimSuggestions(user.id, input.display_name, family.id).catch(() => {})

    return { token, user: { ...user, person_id: person.id, family_id: family.id } }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Find proxy/invited nodes whose name matches the new user's display name. */
async function sendClaimSuggestions(
  userId:          string,
  displayName:     string,
  ownFamilyId:     string,
): Promise<void> {
  const { rows } = await query<{
    id: string; full_name: string; family_name: string
  }>(
    `SELECT p.id, p.full_name, f.name AS family_name
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id
     WHERE  p.full_name           = $1
       AND  p.deleted_at         IS NULL
       AND  p.node_state         IN ('proxy', 'invited')
       AND  p.primary_family_id  != $2
       AND  f.deleted_at         IS NULL
     LIMIT  5`,
    [displayName, ownFamilyId],
  )

  for (const match of rows) {
    await createNotification(
      userId,
      'claim_suggestion',
      `A person named "${match.full_name}" already exists in "${match.family_name}". Is that you? You can request to join that family.`,
      null,
      match.id,
    )
  }
}

export async function login(input: LoginInput) {
  const { rows } = await query<{
    id: string; email: string; display_name: string; password_hash: string; person_id: string
  }>(
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.person_id
     FROM users u WHERE u.email = $1`,
    [input.email]
  )
  const user = rows[0]
  if (!user) throw { status: 401, message: 'Invalid email or password' }

  const valid = await bcrypt.compare(input.password, user.password_hash)
  if (!valid) throw { status: 401, message: 'Invalid email or password' }

  const { rows: [member] } = await query<{ family_id: string }>(
    `SELECT family_id FROM family_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1`,
    [user.id]
  )
  if (!member) throw { status: 500, message: 'No family found for user' }

  const token = signToken({ userId: user.id, familyId: member.family_id })
  const { password_hash: _, ...safeUser } = user
  return { token, user: { ...safeUser, family_id: member.family_id } }
}

export async function signupViaInvite(input: SignupInput & { invite_token: string }) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
  if ((existing.rowCount ?? 0) > 0) throw { status: 409, message: 'Email already registered' }

  const { rows: [person] } = await query<{
    id: string; primary_family_id: string; node_state: string
  }>(
    `SELECT id, primary_family_id, node_state FROM persons
     WHERE invite_token = $1 AND deleted_at IS NULL`,
    [input.invite_token.toUpperCase()]
  )
  if (!person) throw { status: 404, message: 'Invalid or expired invite code' }
  if (person.node_state === 'claimed') throw { status: 409, message: 'This node has already been claimed' }

  const passwordHash = await bcrypt.hash(input.password, 10)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: [user] } = await client.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [input.email, input.display_name, passwordHash]
    )

    await client.query(
      `UPDATE persons SET node_state = 'claimed', claimed_by = $1, invite_token = NULL, updated_at = NOW()
       WHERE id = $2`,
      [user.id, person.id]
    )

    await client.query(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'member')`,
      [person.primary_family_id, user.id]
    )

    await client.query(
      `UPDATE users SET person_id = $1 WHERE id = $2`,
      [person.id, user.id]
    )

    await client.query('COMMIT')

    const token = signToken({ userId: user.id, familyId: person.primary_family_id })
    return { token, user: { ...user, person_id: person.id, family_id: person.primary_family_id } }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Re-issue a JWT for an already-authenticated user.
 * Picks the family that contains the user's active person node.
 * This is called after a merge so the claimant's token reflects the new family.
 */
export async function refreshToken(userId: string): Promise<{ token: string }> {
  const { rows: [user] } = await query<{ person_id: string | null }>(
    `SELECT person_id FROM users WHERE id = $1`,
    [userId],
  )

  // Prefer the family where person_id lives; fall back to the earliest membership.
  const { rows: [member] } = await query<{ family_id: string }>(
    `SELECT fm.family_id
     FROM   family_members fm
     LEFT JOIN persons p
       ON  p.primary_family_id = fm.family_id
       AND p.id                = $2
       AND p.deleted_at       IS NULL
     WHERE  fm.user_id = $1
     ORDER BY (p.id IS NOT NULL) DESC, fm.joined_at ASC
     LIMIT 1`,
    [userId, user?.person_id ?? null],
  )
  if (!member) throw { status: 500, message: 'No family found for user' }

  const token = signToken({ userId, familyId: member.family_id })
  return { token }
}

export async function getMe(userId: string) {
  const { rows } = await query<{
    id: string; email: string; display_name: string; person_id: string
  }>(
    `SELECT id, email, display_name, person_id FROM users WHERE id = $1`,
    [userId]
  )
  if (!rows[0]) throw { status: 404, message: 'User not found' }
  return rows[0]
}
