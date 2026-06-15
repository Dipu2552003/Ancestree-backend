import bcrypt from 'bcrypt'
import { query } from '../utils/db'
import { withOperation, auditCreate, captureAndUpdate, type Snapshot } from '../utils/audit'
import { signToken } from '../utils/jwt'
import { logger } from '../utils/logger'
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
}

interface CommunityPublic extends CommunityRow {
  member_count: number
}

async function getBySlug(slug: string): Promise<CommunityRow> {
  const { rows: [community] } = await query<CommunityRow>(
    `SELECT id, name, slug, description, owner_id, member_limit
     FROM communities WHERE slug = $1`,
    [slug],
  )
  if (!community) throw notFound('Community not found')
  return community
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

    const { rows: [community] } = await tx.query<{ id: string; name: string; slug: string }>(
      `INSERT INTO communities (name, slug, description, owner_id, member_limit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug`,
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
    community: { id: community.id, name: community.name, slug: community.slug },
    user: { id: user.id, email: user.email, display_name: user.display_name, person_id: person.id, family_id: family.id, community_id: community.id },
  }
}

export async function getCommunity(slug: string): Promise<CommunityPublic> {
  const { rows: [community] } = await query<CommunityPublic>(
    `SELECT c.id, c.name, c.slug, c.description, c.owner_id, c.member_limit,
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

  if (setClauses.length === 0) return community

  setClauses.push(`updated_at = NOW()`)
  params.push(community.id)

  const { rows: [updated] } = await query<CommunityRow>(
    `UPDATE communities SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, description, owner_id, member_limit`,
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

  // Invite code is optional — communities allow open signup by default.
  // If a code is provided, validate it so invite-specific tracking still works.
  let inviteId: string | null = null
  if (input.invite_code) {
    const { rows: [invite] } = await query<{ id: string }>(
      `SELECT id FROM community_invites
       WHERE  invite_code = $1 AND community_id = $2 AND used_by IS NULL
         AND  (expires_at IS NULL OR expires_at > NOW())`,
      [input.invite_code, community.id],
    )
    if (!invite) throw badRequest('Invalid or expired invite code')
    inviteId = invite.id
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
  if ((existing.rowCount ?? 0) > 0) throw conflict('Email already registered')

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
          visibility, community_id)
       VALUES ($1, $2, $3, 'claimed', $4, $4, 'community', $5) RETURNING *`,
      [personCode, family.id, input.display_name, user.id, community.id],
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

  const { rows } = await query(
    `SELECT u.id, u.email, u.display_name, cm.role, cm.joined_at
     FROM   community_members cm
     JOIN   users u ON u.id = cm.user_id
     WHERE  cm.community_id = $1
     ORDER  BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at`,
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

export async function listCommunityFamilies(slug: string, requesterId: string) {
  const community = await getBySlug(slug)
  await assertAdmin(community.id, requesterId)

  const { rows } = await query(
    `SELECT f.id, f.name, f.name_prefix, f.created_at,
            COUNT(DISTINCT p.id)::int   AS person_count,
            COUNT(DISTINCT fm.user_id)::int AS member_count
     FROM   families f
     LEFT   JOIN persons p         ON p.primary_family_id = f.id AND p.deleted_at IS NULL
     LEFT   JOIN family_members fm ON fm.family_id = f.id
     WHERE  f.community_id = $1 AND f.deleted_at IS NULL
     GROUP  BY f.id
     ORDER  BY f.created_at DESC`,
    [community.id],
  )
  return { families: rows }
}
