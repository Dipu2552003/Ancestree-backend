import bcrypt from 'bcrypt'
import crypto from 'crypto'
import pool, { query } from '../utils/db'
import { deletePerson } from './persons.service'
import { withOperation, auditCreate, captureAndUpdate, type Snapshot } from '../utils/audit'
import { signToken } from '../utils/jwt'
import { logger } from '../utils/logger'
import { sendMail, brandEmail } from '../utils/email'
import { badRequest, unauthorized, notFound, conflict, forbidden, serverError } from '../utils/errors'
import type {
  CreateCommunityInput, CommunityLoginInput, CommunitySignupInput,
  InviteToCommunityInput, UpdateMemberRoleInput,
  UpdateCommunityInput, JoinCommunityInput,
} from '../schemas/community.schema'

// ── Private helpers ────────────────────────────────────────────────────────────

interface CommunityRow {
  id: string; name: string; slug: string
  description: string | null; owner_id: string; member_limit: number
  site_url: string | null
}

interface CommunityPublic extends CommunityRow {
  member_count: number
}

async function getBySlug(slug: string): Promise<CommunityRow> {
  const { rows: [community] } = await query<CommunityRow>(
    `SELECT id, name, slug, description, owner_id, member_limit, site_url
     FROM communities WHERE slug = $1`,
    [slug],
  )
  if (!community) throw notFound('Community not found')
  return community
}

/** Field config for a community's data-entry / search forms:
 *  - `fields`  — the rulebook from communities.settings.fields (which fields are
 *    enum vs constant/auto-fill). `{}` until seeded.
 *  - `options` — the option catalogs for enum fields, grouped by field_key, each
 *    `{ value, label }` (value = canonical Hindi, label = English display).
 *  Public: it's reference data (gotra / village lists), not member PII. */
export async function getFieldConfig(slug: string) {
  const community = await getBySlug(slug)
  const { rows: [row] } = await query<{ settings: { fields?: Record<string, unknown> } | null }>(
    `SELECT settings FROM communities WHERE id = $1`,
    [community.id],
  )
  const { rows: opts } = await query<{ field_key: string; value: string; label: string | null }>(
    `SELECT field_key, value, label
     FROM   community_field_options
     WHERE  community_id = $1 AND active
     ORDER  BY field_key, sort_order, value`,
    [community.id],
  )
  const options: Record<string, { value: string; label: string | null }[]> = {}
  for (const o of opts) (options[o.field_key] ??= []).push({ value: o.value, label: o.label })
  return { fields: row?.settings?.fields ?? {}, options }
}

/** Admin: replace the community's field rulebook (settings.fields). Returns the
 *  refreshed field config. */
export async function updateFieldConfig(
  slug: string, userId: string, fields: Record<string, unknown>,
) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, userId)
  await query(
    `UPDATE communities
     SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('fields', $2::jsonb),
         updated_at = NOW()
     WHERE id = $1`,
    [community.id, JSON.stringify(fields)],
  )
  return getFieldConfig(slug)
}

/** Admin: replace ALL option rows for one enum field (gotra / village / …) in a
 *  single transaction, so a failed write never leaves the list half-updated. */
export async function replaceFieldOptions(
  slug: string, userId: string, fieldKey: string,
  options: { value: string; label?: string | null }[],
) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, userId)

  const clean = options
    .map(o => ({ value: (o.value ?? '').trim(), label: o.label?.trim() || null }))
    .filter(o => o.value)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM community_field_options WHERE community_id = $1 AND field_key = $2`,
      [community.id, fieldKey],
    )
    let i = 0
    for (const o of clean) {
      await client.query(
        `INSERT INTO community_field_options (community_id, field_key, value, label, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [community.id, fieldKey, o.value, o.label, i++],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return getFieldConfig(slug)
}

async function assertAdmin(communityId: string, userId: string): Promise<void> {
  const { rows: [member] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [communityId, userId],
  )
  if (!member || !['owner', 'admin'].includes(member.role)) {
    throw forbidden('Community admin access required')
  }
}

/** Total person nodes across every tree in the community (all families
 *  combined), for the community-wide count on the family badge. */
export async function getCommunityStats(slug: string) {
  const community = await getBySlug(slug)
  const { rows: [row] } = await query<{ total_persons: string }>(
    `SELECT COUNT(*)::text AS total_persons
     FROM   persons
     WHERE  community_id = $1 AND deleted_at IS NULL`,
    [community.id],
  )
  return { total_persons: parseInt(row?.total_persons ?? '0', 10) }
}

/** The requester's own membership in a community — lets the UI reveal
 *  role-gated tools (e.g. the owner's merge console). */
export async function getMyCommunityRole(slug: string, userId: string) {
  const community = await getBySlug(slug)
  const { rows: [member] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, userId],
  )
  return {
    role:     member?.role ?? null,
    is_owner: community.owner_id === userId,
  }
}

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

// ── Public API ─────────────────────────────────────────────────────────────────

export async function createCommunity(input: CreateCommunityInput) {
  const { rows: [existing] } = await query('SELECT id FROM communities WHERE slug = $1', [input.slug])
  if (existing) throw conflict('A community with this slug already exists')

  const { rows: [existingUser] } = await query('SELECT id FROM users WHERE email = $1', [input.owner.email])
  if (existingUser) throw conflict('Email already registered')

  const passwordHash = await bcrypt.hash(input.owner.password, 10)
  const namePrefix = await uniquePrefix(buildNamePrefix(input.owner.display_name))

  const { user, community, family, person } = await withOperation({ action: 'community.create' }, async op => {
    const tx = op.tx

    const { rows: [user] } = await tx.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [input.owner.email, input.owner.display_name, passwordHash],
    )
    op.actorId = user.id

    const { rows: [community] } = await tx.query<{ id: string; name: string; slug: string; join_code: string }>(
      `INSERT INTO communities (name, slug, description, owner_id, member_limit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, join_code`,
      [input.name, input.slug, input.description ?? null, user.id, input.member_limit ?? 0],
    )

    const { rows: [family] } = await tx.query<Snapshot & { id: string }>(
      `INSERT INTO families (name, name_prefix, created_by, community_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [`${input.owner.display_name}'s Family`, namePrefix, user.id, community.id],
    )
    op.familyId = family.id
    await auditCreate(op, 'family', family)

    const { rows: [membership] } = await tx.query<Snapshot>(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING *`,
      [family.id, user.id],
    )
    await auditCreate(op, 'family_member', membership)

    const personCode = `${namePrefix}-001`
    const { rows: [person] } = await tx.query<Snapshot & { id: string }>(
      `INSERT INTO persons
         (person_code, primary_family_id, full_name, node_state, claimed_by, created_by,
          visibility, community_id)
       VALUES ($1, $2, $3, 'claimed', $4, $4, 'community', $5) RETURNING *`,
      [personCode, family.id, input.owner.display_name, user.id, community.id],
    )
    await auditCreate(op, 'person', person)

    await captureAndUpdate(op, 'user',
      { sql: 'id = $1', params: [user.id] },
      { sql: 'person_id = $1', params: [person.id] },
      { snapshotCols: 'id, person_id' },
    )

    await tx.query(
      `INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [community.id, user.id],
    )

    return { user, community, family, person }
  })

  const token = signToken({ userId: user.id, familyId: family.id, communityId: community.id })
  logger.info({ communityId: community.id, slug: input.slug, ownerId: user.id }, 'community created')
  return {
    token,
    community: { id: community.id, name: community.name, slug: community.slug, join_code: community.join_code },
    user: { id: user.id, email: user.email, display_name: user.display_name, person_id: person.id, family_id: family.id, community_id: community.id },
  }
}

export async function getCommunity(slug: string): Promise<CommunityPublic> {
  const { rows: [community] } = await query<CommunityPublic>(
    `SELECT c.id, c.name, c.slug, c.description, c.owner_id, c.member_limit, c.site_url,
            COUNT(cm.user_id)::int AS member_count
     FROM   communities c
     LEFT   JOIN community_members cm ON cm.community_id = c.id
     WHERE  c.slug = $1
     GROUP  BY c.id`,
    [slug],
  )
  if (!community) throw notFound('Community not found')
  return community
}

export async function updateCommunity(
  slug: string,
  input: UpdateCommunityInput,
  requesterId: string,
) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  // Slug uniqueness check if slug is changing
  if (input.slug && input.slug !== community.slug) {
    const { rows: [existing] } = await query(
      'SELECT id FROM communities WHERE slug = $1', [input.slug],
    )
    if (existing) throw conflict('A community with this slug already exists')
  }

  const setClauses: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (input.name         !== undefined) { setClauses.push(`name = $${idx++}`);         params.push(input.name) }
  if (input.slug         !== undefined) { setClauses.push(`slug = $${idx++}`);         params.push(input.slug) }
  if (input.description  !== undefined) { setClauses.push(`description = $${idx++}`);  params.push(input.description) }
  if (input.member_limit !== undefined) { setClauses.push(`member_limit = $${idx++}`); params.push(input.member_limit) }
  if (input.site_url     !== undefined) { setClauses.push(`site_url = $${idx++}`);     params.push(input.site_url) }

  if (setClauses.length === 0) return community

  setClauses.push(`updated_at = NOW()`)
  params.push(community.id)

  const { rows: [updated] } = await query<CommunityRow>(
    `UPDATE communities SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, description, owner_id, member_limit, site_url`,
    params,
  )

  logger.info({ communityId: community.id, requesterId, fields: Object.keys(input) }, 'community updated')
  return updated
}

export async function deleteCommunity(slug: string, requesterId: string | null) {
  const community = await getBySlug(slug)

  // Platform-admin-created communities (no owner) can only be deleted via admin key
  // (which is already verified in the route before this service is called).
  // User-owned communities additionally require the requester to be the owner.
  if (community.owner_id && community.owner_id !== requesterId) {
    throw forbidden('Only the community owner can delete it')
  }

  // Soft-delete all persons and families that belong to this community
  await query(
    `UPDATE persons SET deleted_at = NOW(), updated_at = NOW()
     WHERE community_id = $1 AND deleted_at IS NULL`,
    [community.id],
  )
  await query(
    `UPDATE families SET deleted_at = NOW(), updated_at = NOW()
     WHERE community_id = $1 AND deleted_at IS NULL`,
    [community.id],
  )
  // Clear FK references so the community row can be hard-deleted
  // (families + persons do NOT have ON DELETE CASCADE on community_id)
  await query(`UPDATE persons  SET community_id = NULL WHERE community_id = $1`, [community.id])
  await query(`UPDATE families SET community_id = NULL WHERE community_id = $1`, [community.id])
  // Hard-delete the community — cascades to community_members + community_invites
  await query(`DELETE FROM communities WHERE id = $1`, [community.id])

  logger.info({ communityId: community.id, requesterId }, 'community deleted')
  return { success: true }
}

export async function communityLogin(slug: string, input: CommunityLoginInput) {
  const community = await getBySlug(slug)

  const { rows: [user] } = await query<{
    id: string; email: string; display_name: string; password_hash: string; person_id: string
  }>(
    `SELECT id, email, display_name, password_hash, person_id FROM users WHERE email = $1`,
    [input.email],
  )
  if (!user) throw unauthorized('Invalid email or password')

  const valid = await bcrypt.compare(input.password, user.password_hash)
  if (!valid) throw unauthorized('Invalid email or password')

  const { rows: [member] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, user.id],
  )
  if (!member) throw forbidden('You are not a member of this community')

  // Pick the family that belongs to this community
  const { rows: [fm] } = await query<{ family_id: string }>(
    `SELECT fm.family_id
     FROM   family_members fm
     JOIN   families f ON f.id = fm.family_id AND f.deleted_at IS NULL
     WHERE  fm.user_id = $1 AND f.community_id = $2
     ORDER  BY fm.joined_at ASC
     LIMIT  1`,
    [user.id, community.id],
  )
  if (!fm) throw serverError('No family found for user in this community')

  const token = signToken({ userId: user.id, familyId: fm.family_id, communityId: community.id })
  logger.info({ userId: user.id, communityId: community.id, slug }, 'community login')
  const { password_hash: _, ...safeUser } = user
  return { token, user: { ...safeUser, family_id: fm.family_id, community_id: community.id } }
}

const SIGNUP_CODE_TTL_MS = 60 * 60 * 1000 // 1 hour
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Validates an invite/join code for a community. Returns the
 *  community_invites row id for a targeted single-use invite (so the caller can
 *  consume it later), or null for the community's permanent join_code. Throws
 *  badRequest if the code is invalid or expired. */
async function resolveInviteCode(communityId: string, inviteCode: string): Promise<string | null> {
  const { rows: [invite] } = await query<{ id: string }>(
    `SELECT id FROM community_invites
     WHERE  invite_code = $1 AND community_id = $2 AND used_by IS NULL
       AND  (expires_at IS NULL OR expires_at > NOW())`,
    [inviteCode, communityId],
  )
  if (invite) return invite.id

  const { rows: [joinMatch] } = await query<{ id: string }>(
    `SELECT id FROM communities WHERE id = $1 AND join_code = $2`,
    [communityId, inviteCode],
  )
  if (!joinMatch) throw badRequest('Invalid or expired invite code')
  return null
}

/**
 * Emails a 6-digit signup verification code, valid for 1 hour. Requires the
 * community to exist, a valid invite code, and the email to be unregistered.
 * Re-requesting replaces any prior code for that email.
 */
export async function sendSignupCode(slug: string, email: string, inviteCode: string) {
  const community = await getBySlug(slug) // 404s on unknown community
  await resolveInviteCode(community.id, inviteCode) // 400s before we email anything

  const existing = await query('SELECT id FROM users WHERE email = $1', [email])
  if ((existing.rowCount ?? 0) > 0) throw conflict('Email already registered')

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = new Date(Date.now() + SIGNUP_CODE_TTL_MS)

  await query(
    `INSERT INTO signup_verifications (email, code_hash, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (email)
     DO UPDATE SET code_hash = EXCLUDED.code_hash,
                   expires_at = EXCLUDED.expires_at,
                   created_at = NOW()`,
    [email, sha256(code), expiresAt],
  )

  await sendMail({
    to: email,
    subject: 'Your Khandelwal Parivar verification code',
    text: `Your verification code is ${code}. It expires in 1 hour.`,
    html: brandEmail('Verify your email',
      `<p>Your verification code is:</p>
       <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#EA580C;margin:16px 0">${code}</p>
       <p style="font-size:13px;color:#8a7a67">This code expires in 1 hour. If you didn't request it, ignore this email.</p>`),
  })

  return { success: true }
}

/** Checks a signup code is valid & unexpired WITHOUT consuming it. Powers the
 *  standalone OTP-confirm step; the code is consumed later at communitySignup. */
export async function peekSignupCode(email: string, code: string) {
  const { rows: [row] } = await query<{ code_hash: string }>(
    `SELECT code_hash FROM signup_verifications
     WHERE email = $1 AND expires_at > NOW()`,
    [email],
  )
  if (!row || row.code_hash !== sha256(code)) {
    throw badRequest('This verification code is invalid or has expired. Request a new one.')
  }
  return { success: true }
}

/** Consumes a valid, unexpired signup code for the email, else throws. */
export async function verifySignupCode(email: string, code: string) {
  const { rows: [row] } = await query<{ code_hash: string }>(
    `SELECT code_hash FROM signup_verifications
     WHERE email = $1 AND expires_at > NOW()`,
    [email],
  )
  if (!row || row.code_hash !== sha256(code)) {
    throw badRequest('This verification code is invalid or has expired. Request a new one.')
  }
  await query('DELETE FROM signup_verifications WHERE email = $1', [email])
}

// ── Login via one-time code (OTP) ────────────────────────────────────────────
// An alternative to password login: email a 6-digit code to a registered member,
// then exchange it for a session. Reuses the signup_verifications table (email-
// keyed, single active code) since a login OTP is just as transient.

const LOGIN_OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Emails a 6-digit login code to a registered member of this community. To
 *  avoid leaking which emails exist, always resolves { success: true }; a code
 *  is only actually sent when the email belongs to a member of the community. */
export async function sendLoginOtp(slug: string, email: string) {
  const community = await getBySlug(slug) // 404s on unknown community

  const { rows: [user] } = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`, [email],
  )
  if (user) {
    const { rows: [member] } = await query<{ role: string }>(
      `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
      [community.id, user.id],
    )
    if (member) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MS)
      await query(
        `INSERT INTO signup_verifications (email, code_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (email)
         DO UPDATE SET code_hash = EXCLUDED.code_hash,
                       expires_at = EXCLUDED.expires_at,
                       created_at = NOW()`,
        [email, sha256(code), expiresAt],
      )
      await sendMail({
        to: email,
        subject: 'Your Khandelwal Parivar login code',
        text: `Your login code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`,
        html: brandEmail('Your login code',
          `<p>Use this code to sign in:</p>
           <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#EA580C;margin:16px 0">${code}</p>
           <p style="font-size:13px;color:#8a7a67">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.</p>`),
      })
      logger.info({ email, slug }, 'login OTP sent')
    }
  }
  return { success: true }
}

/** Verifies a login OTP and issues a session (same shape as communityLogin). */
export async function loginWithOtp(slug: string, email: string, code: string) {
  const community = await getBySlug(slug)

  const { rows: [row] } = await query<{ code_hash: string }>(
    `SELECT code_hash FROM signup_verifications WHERE email = $1 AND expires_at > NOW()`,
    [email],
  )
  if (!row || row.code_hash !== sha256(code)) {
    throw badRequest('This login code is invalid or has expired. Request a new one.')
  }

  const { rows: [user] } = await query<{
    id: string; email: string; display_name: string; person_id: string
  }>(
    `SELECT id, email, display_name, person_id FROM users WHERE email = $1`,
    [email],
  )
  if (!user) throw unauthorized('Invalid email or code')

  const { rows: [member] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, user.id],
  )
  if (!member) throw forbidden('You are not a member of this community')

  const { rows: [fm] } = await query<{ family_id: string }>(
    `SELECT fm.family_id
     FROM   family_members fm
     JOIN   families f ON f.id = fm.family_id AND f.deleted_at IS NULL
     WHERE  fm.user_id = $1 AND f.community_id = $2
     ORDER  BY fm.joined_at ASC
     LIMIT  1`,
    [user.id, community.id],
  )
  if (!fm) throw serverError('No family found for user in this community')

  // Consume the code now that the login is fully validated.
  await query('DELETE FROM signup_verifications WHERE email = $1', [email])

  const token = signToken({ userId: user.id, familyId: fm.family_id, communityId: community.id })
  logger.info({ userId: user.id, communityId: community.id, slug }, 'community login via OTP')
  return { token, user: { ...user, family_id: fm.family_id, community_id: community.id } }
}

export async function communitySignup(slug: string, input: CommunitySignupInput) {
  const community = await getBySlug(slug)

  // Member limit check
  if (community.member_limit > 0) {
    const { rows: [{ count }] } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM community_members WHERE community_id = $1`,
      [community.id],
    )
    if (parseInt(count, 10) >= community.member_limit) {
      throw forbidden('This community has reached its member limit')
    }
  }

  // Invite code is required — open signup is disabled for communities. Accepts
  // either a targeted single-use invite or the community's permanent join_code.
  if (!input.invite_code) throw badRequest('An invite code is required to join this community')
  const inviteId = await resolveInviteCode(community.id, input.invite_code)

  const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
  if ((existing.rowCount ?? 0) > 0) throw conflict('Email already registered')

  // Confirm the email was verified via the emailed 6-digit code (consumes it).
  await verifySignupCode(input.email, input.code)

  const passwordHash = await bcrypt.hash(input.password, 10)
  const namePrefix = await uniquePrefix(buildNamePrefix(input.display_name))

  const { user, family, person } = await withOperation({ action: 'family.create' }, async op => {
    const tx = op.tx

    const { rows: [user] } = await tx.query<{ id: string; email: string; display_name: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [input.email, input.display_name, passwordHash],
    )
    op.actorId = user.id

    const { rows: [family] } = await tx.query<Snapshot & { id: string }>(
      `INSERT INTO families (name, name_prefix, created_by, community_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [`${input.display_name}'s Family`, namePrefix, user.id, community.id],
    )
    op.familyId = family.id
    await auditCreate(op, 'family', family)

    const { rows: [membership] } = await tx.query<Snapshot>(
      `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING *`,
      [family.id, user.id],
    )
    await auditCreate(op, 'family_member', membership)

    const personCode = `${namePrefix}-001`
    const { rows: [person] } = await tx.query<Snapshot & { id: string }>(
      `INSERT INTO persons
         (person_code, primary_family_id, full_name, node_state, claimed_by, created_by,
          visibility, community_id, gotra, native_village, current_city, photo_url)
       VALUES ($1, $2, $3, 'claimed', $4, $4, 'community', $5, $6, $7, $8, $9) RETURNING *`,
      [personCode, family.id, input.display_name, user.id, community.id,
       input.gotra ?? null, input.native_village ?? null,
       input.current_city ?? null, input.photo_url || null],
    )
    await auditCreate(op, 'person', person)

    await captureAndUpdate(op, 'user',
      { sql: 'id = $1', params: [user.id] },
      { sql: 'person_id = $1', params: [person.id] },
      { snapshotCols: 'id, person_id' },
    )

    await tx.query(
      `INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member')`,
      [community.id, user.id],
    )

    if (inviteId) {
      await tx.query(
        `UPDATE community_invites SET used_by = $1, used_at = NOW() WHERE id = $2`,
        [user.id, inviteId],
      )
    }

    return { user, family, person }
  })

  const token = signToken({ userId: user.id, familyId: family.id, communityId: community.id })
  logger.info({ userId: user.id, communityId: community.id, familyId: family.id }, 'community signup')
  return {
    token,
    user: { ...user, person_id: person.id, family_id: family.id, community_id: community.id },
  }
}

/** Join an existing community as an already-authenticated platform user. */
export async function joinCommunity(
  slug: string,
  userId: string,
  input: JoinCommunityInput,
) {
  const community = await getBySlug(slug)

  // Idempotent: already a member → return a refreshed community JWT
  const { rows: [existingMember] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, userId],
  )
  if (existingMember) {
    const { rows: [fm] } = await query<{ family_id: string }>(
      `SELECT fm.family_id
       FROM   family_members fm
       JOIN   families f ON f.id = fm.family_id AND f.deleted_at IS NULL
       WHERE  fm.user_id = $1 AND f.community_id = $2
       ORDER  BY fm.joined_at ASC LIMIT 1`,
      [userId, community.id],
    )
    if (!fm) throw serverError('Member family not found')
    const token = signToken({ userId, familyId: fm.family_id, communityId: community.id })
    return { token, family_id: fm.family_id, community_id: community.id, already_member: true }
  }

  // Member limit check
  if (community.member_limit > 0) {
    const { rows: [{ count }] } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM community_members WHERE community_id = $1`,
      [community.id],
    )
    if (parseInt(count, 10) >= community.member_limit) {
      throw forbidden('This community has reached its member limit')
    }
  }

  let inviteId: string | null = null
  let inviteRole = 'member'
  if (input.invite_code) {
    const { rows: [invite] } = await query<{ id: string; role: string }>(
      `SELECT id, role FROM community_invites
       WHERE  invite_code = $1 AND community_id = $2 AND used_by IS NULL
         AND  (expires_at IS NULL OR expires_at > NOW())`,
      [input.invite_code, community.id],
    )
    if (!invite) throw badRequest('Invalid or expired invite code')
    inviteId = invite.id
    inviteRole = invite.role
  }

  const { rows: [user] } = await query<{ display_name: string }>(
    `SELECT display_name FROM users WHERE id = $1`,
    [userId],
  )
  if (!user) throw notFound('User not found')

  const namePrefix = await uniquePrefix(buildNamePrefix(user.display_name))

  const { family, person } = await withOperation(
    { action: 'community.join', actorId: userId },
    async op => {
      const tx = op.tx

      const { rows: [family] } = await tx.query<Snapshot & { id: string }>(
        `INSERT INTO families (name, name_prefix, created_by, community_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [`${user.display_name}'s Family`, namePrefix, userId, community.id],
      )
      op.familyId = family.id
      await auditCreate(op, 'family', family)

      const { rows: [membership] } = await tx.query<Snapshot>(
        `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING *`,
        [family.id, userId],
      )
      await auditCreate(op, 'family_member', membership)

      const personCode = `${namePrefix}-001`
      const { rows: [person] } = await tx.query<Snapshot & { id: string }>(
        `INSERT INTO persons
           (person_code, primary_family_id, full_name, node_state, claimed_by, created_by,
            visibility, community_id)
         VALUES ($1, $2, $3, 'claimed', $4, $4, 'community', $5) RETURNING *`,
        [personCode, family.id, user.display_name, userId, community.id],
      )
      await auditCreate(op, 'person', person)

      await tx.query(
        `INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3)`,
        [community.id, userId, inviteRole],
      )

      if (inviteId) {
        await tx.query(
          `UPDATE community_invites SET used_by = $1, used_at = NOW() WHERE id = $2`,
          [userId, inviteId],
        )
      }

      return { family, person }
    },
  )

  const token = signToken({ userId, familyId: family.id, communityId: community.id })
  logger.info({ userId, communityId: community.id, familyId: family.id }, 'community join')
  return {
    token,
    family_id:    family.id,
    person_id:    person.id,
    community_id: community.id,
    already_member: false,
  }
}

/** Leave a community voluntarily (non-owner members only). */
export async function leaveCommunity(slug: string, userId: string) {
  const community = await getBySlug(slug)

  if (userId === community.owner_id) {
    throw forbidden('The community owner cannot leave. Transfer ownership or delete the community.')
  }

  const { rowCount } = await query(
    `DELETE FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, userId],
  )
  if (!rowCount) throw notFound('You are not a member of this community')

  logger.info({ communityId: community.id, userId }, 'community leave')
  return { success: true }
}

export async function inviteToCommunity(slug: string, input: InviteToCommunityInput, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  const expiresAt = input.expires_in_days
    ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000)
    : null

  const { rows: [invite] } = await query<{ id: string; invite_code: string; expires_at: string | null }>(
    `INSERT INTO community_invites (community_id, invited_email, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, invite_code, expires_at`,
    [community.id, input.invited_email ?? null, input.role ?? 'member', requesterId, expiresAt],
  )

  logger.info({ communityId: community.id, inviteId: invite.id, requesterId }, 'community invite created')
  return { invite_code: invite.invite_code, community_slug: slug, expires_at: invite.expires_at }
}

export async function getCommunityMembers(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  // Admin directory of everyone who has signed up: name, email, photo and their
  // own person node (so the UI can deep-link to their tree). Newest signup first
  // — joined_at is when they joined the community, i.e. when they signed up.
  const { rows } = await query(
    `SELECT u.id, u.email, u.display_name, cm.role, cm.joined_at,
            u.person_id,
            p.full_name  AS person_name,
            p.photo_url,
            p.primary_family_id AS family_id
     FROM   community_members cm
     JOIN   users   u ON u.id = cm.user_id
     LEFT   JOIN persons p ON p.id = u.person_id AND p.deleted_at IS NULL
     WHERE  cm.community_id = $1
     ORDER  BY cm.joined_at DESC`,
    [community.id],
  )
  return { members: rows }
}

export async function updateMemberRole(
  slug: string, targetUserId: string, input: UpdateMemberRoleInput, requesterId: string,
) {
  const community = await getBySlug(slug)

  const { rows: [requesterMember] } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, requesterId],
  )
  if (!requesterMember) throw forbidden('Not a member of this community')
  if (!['owner', 'admin'].includes(requesterMember.role)) throw forbidden('Community admin access required')
  if (requesterMember.role !== 'owner' && input.role === 'admin') {
    throw forbidden('Only the community owner can promote members to admin')
  }
  if (targetUserId === community.owner_id) throw forbidden('Cannot change the owner role')

  const { rowCount } = await query(
    `UPDATE community_members SET role = $1 WHERE community_id = $2 AND user_id = $3`,
    [input.role, community.id, targetUserId],
  )
  if (!rowCount) throw notFound('Member not found in this community')

  logger.info({ communityId: community.id, targetUserId, newRole: input.role, requesterId }, 'member role updated')
  return { success: true }
}

export async function removeMember(slug: string, targetUserId: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  if (targetUserId === community.owner_id) throw forbidden('Cannot remove the community owner')

  const { rowCount } = await query(
    `DELETE FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, targetUserId],
  )
  if (!rowCount) throw notFound('Member not found in this community')

  logger.info({ communityId: community.id, targetUserId, requesterId }, 'community member removed')
  return { success: true }
}

export async function listCommunities() {
  const { rows } = await query<CommunityPublic>(
    `SELECT c.id, c.name, c.slug, c.description, c.owner_id, c.member_limit,
            COUNT(cm.user_id)::int AS member_count
     FROM   communities c
     LEFT   JOIN community_members cm ON cm.community_id = c.id
     GROUP  BY c.id
     ORDER  BY c.created_at DESC`,
  )
  return { communities: rows }
}

export async function getJoinCode(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  const { rows: [row] } = await query<{ join_code: string; site_url: string | null }>(
    `SELECT join_code, site_url FROM communities WHERE id = $1`,
    [community.id],
  )
  return { join_code: row.join_code, community_slug: slug, site_url: row.site_url }
}

export async function resetJoinCode(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  const { rows: [row] } = await query<{ join_code: string }>(
    `UPDATE communities
     SET join_code = encode(gen_random_bytes(10), 'hex'), updated_at = NOW()
     WHERE id = $1
     RETURNING join_code`,
    [community.id],
  )
  logger.info({ communityId: community.id, requesterId }, 'community join_code reset')
  return { join_code: row.join_code, community_slug: slug }
}

export async function listCommunityFamilies(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  const { rows } = await query(
    `SELECT f.id, f.name, f.name_prefix, f.created_at,
            COUNT(DISTINCT p.id)::int       AS person_count,
            COUNT(DISTINCT fm.user_id)::int AS member_count,
            rep.person_id AS view_person_id,
            rep.full_name AS view_person_name
     FROM   families f
     LEFT   JOIN persons p         ON p.primary_family_id = f.id AND p.deleted_at IS NULL
     LEFT   JOIN family_members fm ON fm.family_id = f.id
     -- A representative person to open when the admin clicks the family: prefer a
     -- claimed (owned) node, then the family creator's, then anyone — so the click
     -- always lands somewhere real in that tree.
     LEFT   JOIN LATERAL (
       SELECT rp.id AS person_id, rp.full_name
       FROM   persons rp
       WHERE  rp.primary_family_id = f.id AND rp.deleted_at IS NULL
       ORDER  BY (rp.node_state = 'claimed') DESC,
                 (rp.created_by = f.created_by) DESC,
                 rp.person_code
       LIMIT 1
     ) rep ON true
     WHERE  f.community_id = $1 AND f.deleted_at IS NULL
     GROUP  BY f.id, rep.person_id, rep.full_name
     ORDER  BY f.created_at DESC`,
    [community.id],
  )
  return { families: rows }
}

/**
 * Data-health report for the admin dashboard. Surfaces the 1:1 ownership issues
 * that block the uq_persons_claimed_by / uq_users_person_id constraints (migration
 * 028 skips the index when the data is dirty, rather than crashing startup). Also
 * reports whether each constraint index is actually present, so admins know
 * whether the guarantee is live.
 */
/** Resolve a node that belongs to `communityId`, or throw. */
async function resolveCommunityNode(personId: string, communityId: string) {
  const { rows: [node] } = await query<{ id: string; primary_family_id: string; claimed_by: string | null; community_id: string | null }>(
    `SELECT p.id, p.primary_family_id, p.claimed_by, f.community_id
     FROM   persons p JOIN families f ON f.id = p.primary_family_id
     WHERE  p.id = $1 AND p.deleted_at IS NULL`,
    [personId],
  )
  if (!node) throw notFound('Node not found')
  if (node.community_id !== communityId) throw forbidden('That node is not in this community')
  return node
}

/** Admin: strip a node's ownership without deleting it. Clears both sides of the
 *  1:1 link (persons.claimed_by + the owning user's person_id) and drops the node
 *  back to 'proxy'. Fixes accidental multi-ownership and unblocks deletion of a
 *  node that "can't be deleted because it has an owner". */
export async function revokeNodeOwnership(slug: string, requesterId: string, personId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)
  const node = await resolveCommunityNode(personId, community.id)
  if (!node.claimed_by) return { success: true, revoked: false }

  await withOperation(
    { action: 'person.revoke_ownership', actorId: requesterId, familyId: node.primary_family_id },
    async op => {
      await captureAndUpdate(
        op, 'person',
        { sql: 'id = $1', params: [personId] },
        { sql: `claimed_by = NULL, node_state = 'proxy', updated_at = NOW()`, params: [] },
        { snapshotCols: 'id, claimed_by, node_state, full_name, primary_family_id' },
      )
      // Clear the reverse user -> node pointer so the account no longer maps here.
      await op.tx.query(`UPDATE users SET person_id = NULL, updated_at = NOW() WHERE person_id = $1`, [personId])
    },
  )
  return { success: true, revoked: true }
}

/** Admin: delete a node in this community (cross-family). The node must be
 *  unclaimed first (revoke above); reuses the normal delete rules + the
 *  empty-family auto-cleanup. */
export async function adminDeleteNode(slug: string, requesterId: string, personId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)
  const node = await resolveCommunityNode(personId, community.id)
  if (node.claimed_by) throw badRequest('Revoke this node’s ownership before deleting it')
  return deletePerson(personId, requesterId, node.primary_family_id)
}

/** Admin: fully revoke a user's access ("delete user"). Un-claims every node the
 *  account owns (nodes are KEPT as proxies), drops their community + family
 *  memberships so they can no longer log in, and anonymises the account.
 *
 *  The `users` row can't be hard-deleted — it's referenced as the author/actor of
 *  families, persons, relationships and audit history — so instead we strip all
 *  PII + credentials + node link, leaving an inert stub. Not undoable. */
export async function deleteUserAccount(slug: string, requesterId: string, targetUserId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)
  if (targetUserId === community.owner_id) throw forbidden('The community owner cannot be deleted')
  if (targetUserId === requesterId) throw badRequest('You cannot delete your own account')

  const { rows: [member] } = await query<{ user_id: string }>(
    `SELECT user_id FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [community.id, targetUserId],
  )
  if (!member) throw notFound('That member was not found in this community')

  await withOperation({ action: 'user.delete', actorId: requesterId, familyId: null }, async op => {
    // 1. Un-claim every node this account owns — the nodes stay (as proxies).
    await captureAndUpdate(
      op, 'person',
      { sql: 'claimed_by = $1', params: [targetUserId] },
      { sql: `claimed_by = NULL, node_state = 'proxy', updated_at = NOW()`, params: [] },
      { snapshotCols: 'id, claimed_by, node_state, full_name, primary_family_id' },
    )
    // 2. Drop memberships so they can no longer log in or be listed.
    await op.tx.query(`DELETE FROM community_members WHERE user_id = $1`, [targetUserId])
    await op.tx.query(`DELETE FROM family_members    WHERE user_id = $1`, [targetUserId])
    // 3. Anonymise the account (email is NOT NULL UNIQUE, so tombstone it rather
    //    than null it; kill the password so no credential can ever match).
    await op.tx.query(
      `UPDATE users
       SET email         = 'deleted+' || id::text || '@deleted.invalid',
           password_hash = 'DELETED',
           display_name  = NULL,
           phone         = NULL,
           person_id     = NULL,
           updated_at    = NOW()
       WHERE id = $1`,
      [targetUserId],
    )
  })
  logger.info({ communityId: community.id, targetUserId, requesterId }, 'user account deleted (anonymised)')
  return { success: true }
}

export async function getCommunityHealth(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  // Accounts that own more than one active node in this community.
  const { rows: duplicateOwners } = await query(
    `SELECT p.claimed_by AS user_id, u.display_name, u.email,
            COUNT(*)::int AS node_count,
            array_agg(p.full_name ORDER BY p.created_at) AS node_names,
            array_agg(p.id::text ORDER BY p.created_at) AS node_ids
     FROM   persons p
     JOIN   users u ON u.id = p.claimed_by
     WHERE  p.community_id = $1 AND p.claimed_by IS NOT NULL AND p.deleted_at IS NULL
     GROUP  BY p.claimed_by, u.display_name, u.email
     HAVING COUNT(*) > 1
     ORDER  BY COUNT(*) DESC`,
    [community.id],
  )

  // Nodes in this community pointed at by more than one account.
  const { rows: duplicateLinks } = await query(
    `SELECT u.person_id, p.full_name,
            COUNT(*)::int AS user_count,
            array_agg(u.email) AS emails
     FROM   users u
     JOIN   persons p ON p.id = u.person_id
     WHERE  p.community_id = $1
     GROUP  BY u.person_id, p.full_name
     HAVING COUNT(*) > 1
     ORDER  BY COUNT(*) DESC`,
    [community.id],
  )

  // Are the uniqueness indexes actually in place?
  const { rows: [idx] } = await query<{ claimed_by_idx: boolean; person_id_idx: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'uq_persons_claimed_by') AS claimed_by_idx,
       EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_person_id')    AS person_id_idx`,
  )

  const ownershipConstraintActive = !!idx?.claimed_by_idx && !!idx?.person_id_idx

  return {
    ownership_constraint_active: ownershipConstraintActive,
    duplicate_owners: duplicateOwners,
    duplicate_person_links: duplicateLinks,
  }
}
