import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { query } from '../utils/db'
import { withTransaction } from '../utils/transaction'
import { signToken } from '../utils/jwt'
import {
  SignupInput, LoginInput, CheckEmailInput,
  ChangeEmailInput, ChangePasswordInput,
  ForgotPasswordInput, ResetPasswordInput,
} from '../schemas/auth.schema'
import { createNotification } from './notification.service'
import { logger } from '../utils/logger'
import { badRequest, unauthorized, notFound, conflict, serverError } from '../utils/errors'

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
    logger.warn({ email: input.email }, 'signup: email already registered')
    throw conflict('Email already registered')
  }

  const passwordHash = await bcrypt.hash(input.password, 10)
  const namePrefix = await uniquePrefix(buildNamePrefix(input.display_name))

  const { user, family, person } = await withTransaction(async tx => {
    const { rows: [user] } = await tx.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name`,
      [input.email, input.display_name, passwordHash]
    )

    const { rows: [family] } = await tx.query<{ id: string }>(
      `INSERT INTO families (name, name_prefix, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${input.display_name}'s Family`, namePrefix, user.id]
    )

    await tx.query(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [family.id, user.id]
    )

    const personCode = `${namePrefix}-001`
    const { rows: [person] } = await tx.query<{ id: string }>(
      `INSERT INTO persons
         (person_code, primary_family_id, full_name, node_state, claimed_by, created_by, visibility)
       VALUES ($1, $2, $3, 'claimed', $4, $4, 'family')
       RETURNING id`,
      [personCode, family.id, input.display_name, user.id]
    )

    await tx.query('UPDATE users SET person_id = $1 WHERE id = $2', [person.id, user.id])
    return { user, family, person }
  })

  const token = signToken({ userId: user.id, familyId: family.id })

  sendClaimSuggestions(user.id, input.display_name, family.id).catch(() => {})

  logger.info({ userId: user.id, email: user.email, familyId: family.id }, 'signup')
  return { token, user: { ...user, person_id: person.id, family_id: family.id } }
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
  if (!user) {
    logger.warn({ email: input.email }, 'login: unknown email')
    throw unauthorized('Invalid email or password')
  }

  const valid = await bcrypt.compare(input.password, user.password_hash)
  if (!valid) {
    logger.warn({ email: input.email, userId: user.id }, 'login: wrong password')
    throw unauthorized('Invalid email or password')
  }

  // Prefer the family where person_id lives (same logic as refreshToken).
  // Also exclude soft-deleted families so a merged-away family is never returned.
  const { rows: [member] } = await query<{ family_id: string }>(
    `SELECT fm.family_id
     FROM   family_members fm
     JOIN   families f ON f.id = fm.family_id AND f.deleted_at IS NULL
     LEFT JOIN persons p
       ON  p.primary_family_id = fm.family_id
       AND p.id                = $2
       AND p.deleted_at       IS NULL
     WHERE  fm.user_id = $1
     ORDER BY (p.id IS NOT NULL) DESC, fm.joined_at ASC
     LIMIT 1`,
    [user.id, user.person_id],
  )
  if (!member) throw serverError('No family found for user')

  const token = signToken({ userId: user.id, familyId: member.family_id })
  logger.info({ userId: user.id, familyId: member.family_id }, 'login')
  const { password_hash: _, ...safeUser } = user
  return { token, user: { ...safeUser, family_id: member.family_id } }
}

export async function signupViaInvite(input: SignupInput & { invite_token: string }) {
  const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
  if ((existing.rowCount ?? 0) > 0) throw conflict('Email already registered')

  const { rows: [person] } = await query<{
    id: string; primary_family_id: string; node_state: string
  }>(
    `SELECT id, primary_family_id, node_state FROM persons
     WHERE invite_token = $1 AND deleted_at IS NULL`,
    [input.invite_token.toUpperCase()]
  )
  if (!person) throw notFound('Invalid or expired invite code')
  if (person.node_state === 'claimed') throw conflict('This node has already been claimed')

  const passwordHash = await bcrypt.hash(input.password, 10)

  const user = await withTransaction(async tx => {
    const { rows: [user] } = await tx.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [input.email, input.display_name, passwordHash]
    )

    await tx.query(
      `UPDATE persons SET node_state = 'claimed', claimed_by = $1, invite_token = NULL, updated_at = NOW()
       WHERE id = $2`,
      [user.id, person.id]
    )

    await tx.query(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'member')`,
      [person.primary_family_id, user.id]
    )

    await tx.query(
      `UPDATE users SET person_id = $1 WHERE id = $2`,
      [person.id, user.id]
    )

    return user
  })

  logger.info({ userId: user.id, personId: person.id, familyId: person.primary_family_id }, 'signup via invite')
  const token = signToken({ userId: user.id, familyId: person.primary_family_id })
  return { token, user: { ...user, person_id: person.id, family_id: person.primary_family_id } }
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
  // Exclude soft-deleted families so users without a person_id (e.g. admin-only)
  // are also routed away from a merged-away family after a merge.
  const { rows: [member] } = await query<{ family_id: string }>(
    `SELECT fm.family_id
     FROM   family_members fm
     JOIN   families f ON f.id = fm.family_id AND f.deleted_at IS NULL
     LEFT JOIN persons p
       ON  p.primary_family_id = fm.family_id
       AND p.id                = $2
       AND p.deleted_at       IS NULL
     WHERE  fm.user_id = $1
     ORDER BY (p.id IS NOT NULL) DESC, fm.joined_at ASC
     LIMIT 1`,
    [userId, user?.person_id ?? null],
  )
  if (!member) throw serverError('No family found for user')

  const token = signToken({ userId, familyId: member.family_id })
  return { token }
}

export async function checkEmail(input: CheckEmailInput): Promise<{ exists: boolean }> {
  const { rowCount } = await query('SELECT 1 FROM users WHERE email = $1', [input.email])
  return { exists: (rowCount ?? 0) > 0 }
}

export async function getMe(userId: string) {
  const { rows } = await query<{
    id: string; email: string; display_name: string; person_id: string
  }>(
    `SELECT id, email, display_name, person_id FROM users WHERE id = $1`,
    [userId]
  )
  if (!rows[0]) throw notFound('User not found')
  return rows[0]
}

// ── Profile updates (require current password) ──────────────────────────────

async function verifyCurrentPassword(userId: string, currentPassword: string): Promise<void> {
  const { rows: [row] } = await query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId],
  )
  if (!row) throw notFound('User not found')
  const valid = await bcrypt.compare(currentPassword, row.password_hash)
  if (!valid) {
    logger.warn({ userId }, 'profile update: current password rejected')
    throw unauthorized('Current password is incorrect')
  }
}

export async function changeEmail(userId: string, input: ChangeEmailInput) {
  await verifyCurrentPassword(userId, input.current_password)

  const { rowCount } = await query(
    `SELECT 1 FROM users WHERE email = $1 AND id <> $2`,
    [input.new_email, userId],
  )
  if ((rowCount ?? 0) > 0) {
    throw conflict('That email is already in use')
  }

  const { rows: [updated] } = await query<{ id: string; email: string }>(
    `UPDATE users SET email = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, email`,
    [input.new_email, userId],
  )
  logger.info({ userId, newEmail: updated.email }, 'email changed')
  return { id: updated.id, email: updated.email }
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  await verifyCurrentPassword(userId, input.current_password)

  if (input.current_password === input.new_password) {
    throw badRequest('New password must differ from current password')
  }

  const passwordHash = await bcrypt.hash(input.new_password, 10)
  await query(
    `UPDATE users SET password_hash = $1,
                      reset_token_hash = NULL,
                      reset_token_expires_at = NULL,
                      updated_at = NOW()
     WHERE id = $2`,
    [passwordHash, userId],
  )
  logger.info({ userId }, 'password changed')
  return { success: true }
}

// ── Forgot / reset password (no auth required) ──────────────────────────────

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000  // 1 hour

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * Stub for an email-sending integration. Today this only logs the link to the
 * server console — replace with a real provider (Resend / SES / SendGrid) by
 * swapping the body of this function. Returning silently lets the caller
 * respond with the same "if that email exists, a link was sent" message
 * regardless of whether the account exists, which avoids email enumeration.
 */
async function sendPasswordResetEmail(email: string, resetLink: string) {
  logger.info({ email, resetLink }, 'TODO: integrate email provider — password reset link')
  // eslint-disable-next-line no-console
  console.log(`\n[password-reset] ${email} → ${resetLink}\n`)
}

export async function requestPasswordReset(input: ForgotPasswordInput) {
  const { rows: [user] } = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [input.email],
  )

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = sha256(rawToken)
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)

    await query(
      `UPDATE users SET reset_token_hash       = $1,
                        reset_token_expires_at = $2,
                        updated_at             = NOW()
       WHERE id = $3`,
      [tokenHash, expiresAt, user.id],
    )

    const base = process.env.APP_BASE_URL ?? 'http://localhost:3000'
    const resetLink = `${base}/reset-password?token=${rawToken}`
    await sendPasswordResetEmail(input.email, resetLink).catch(err =>
      logger.warn({ err, email: input.email }, 'sendPasswordResetEmail failed'),
    )
  }

  // Always respond identically — never reveal whether the email is registered.
  return { success: true }
}

export async function resetPassword(input: ResetPasswordInput) {
  const tokenHash = sha256(input.token)
  const { rows: [user] } = await query<{ id: string }>(
    `SELECT id FROM users
     WHERE reset_token_hash       = $1
       AND reset_token_expires_at > NOW()`,
    [tokenHash],
  )
  if (!user) {
    logger.warn({ tokenHashPrefix: tokenHash.slice(0, 8) }, 'reset password: invalid or expired token')
    throw badRequest('This reset link is invalid or has expired. Request a new one.')
  }

  const passwordHash = await bcrypt.hash(input.new_password, 10)
  await query(
    `UPDATE users SET password_hash          = $1,
                      reset_token_hash       = NULL,
                      reset_token_expires_at = NULL,
                      updated_at             = NOW()
     WHERE id = $2`,
    [passwordHash, user.id],
  )
  logger.info({ userId: user.id }, 'password reset via token')
  return { success: true }
}
