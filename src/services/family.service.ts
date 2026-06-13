import { query } from '../utils/db'
import { withOperation, captureAndUpdate, writeAudit, auditCreate, type Snapshot } from '../utils/audit'
import { logger } from '../utils/logger'
import { badRequest, forbidden, notFound } from '../utils/errors'

/**
 * Toggle a public-platform family between 'public' and 'private' visibility.
 * Community families are excluded — their scope is managed by the community.
 *
 * Side-effect: all persons in the family inherit the new visibility so the
 * search index stays consistent. Each person row is individually audited so
 * the change is fully undoable.
 */
export async function updateFamilyVisibility(
  familyId:   string,
  visibility: 'public' | 'private',
  userId:     string,
) {
  // Caller must be a family admin
  const { rows: [member] } = await query<{ role: string }>(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId],
  )
  if (!member || member.role !== 'admin') throw forbidden('Family admin access required')

  const { rows: [fam] } = await query<{ community_id: string | null; visibility: string }>(
    `SELECT community_id, visibility FROM families WHERE id = $1 AND deleted_at IS NULL`,
    [familyId],
  )
  if (!fam) throw notFound('Family not found')
  if (fam.community_id) {
    throw badRequest('Community family visibility is managed at the community level')
  }
  if (fam.visibility === visibility) return { success: true, visibility }

  await withOperation({ action: 'family.update_visibility', actorId: userId, familyId }, async op => {
    // Update the family row
    await captureAndUpdate(op, 'family',
      { sql: 'id = $1', params: [familyId] },
      { sql: 'visibility = $1, updated_at = NOW()', params: [visibility] },
    )
    // Cascade to all persons in this family so search results stay consistent
    await captureAndUpdate(op, 'person',
      { sql: 'primary_family_id = $1 AND deleted_at IS NULL', params: [familyId] },
      { sql: 'visibility = $1, updated_at = NOW()', params: [visibility] },
    )
  })

  logger.info({ familyId, visibility, userId }, 'family visibility updated')
  return { success: true, visibility }
}

// ── Family admins (community feature) ─────────────────────────────────────────
//
// Inside a community, clicking a family's name shows who administers that
// family. Any community member may view the list; only an existing admin of
// the family may promote another member — and only people whose node is
// claimed (owned by a real account) can be promoted.

/** Loads the family and asserts it belongs to a community. */
async function getCommunityFamily(familyId: string): Promise<{ id: string; name: string; community_id: string }> {
  const { rows: [fam] } = await query<{ id: string; name: string; community_id: string | null }>(
    `SELECT id, name, community_id FROM families WHERE id = $1 AND deleted_at IS NULL`,
    [familyId],
  )
  if (!fam) throw notFound('Family not found')
  if (!fam.community_id) {
    throw badRequest('Admin lists are available for community families only')
  }
  return { id: fam.id, name: fam.name, community_id: fam.community_id }
}

export async function getFamilyAdmins(familyId: string, requesterId: string) {
  const fam = await getCommunityFamily(familyId)

  // Viewer access: any member of the same community, or of the family itself.
  const { rows: [communityMember] } = await query(
    `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [fam.community_id, requesterId],
  )
  const { rows: [familyMember] } = await query<{ role: string }>(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, requesterId],
  )
  if (!communityMember && !familyMember) {
    throw forbidden('You are not a member of this community')
  }

  const { rows: admins } = await query<{
    user_id: string; display_name: string; person_id: string | null
    full_name: string | null; photo_url: string | null; joined_at: string
  }>(
    `SELECT u.id AS user_id, u.display_name, fm.joined_at,
            p.id AS person_id, p.full_name, p.photo_url
     FROM   family_members fm
     JOIN   users u   ON u.id = fm.user_id
     LEFT   JOIN persons p ON p.id = u.person_id AND p.deleted_at IS NULL
     WHERE  fm.family_id = $1 AND fm.role = 'admin'
     ORDER  BY fm.joined_at ASC`,
    [familyId],
  )

  return {
    family_name: fam.name,
    admins,
    can_manage: familyMember?.role === 'admin',
  }
}

export async function addFamilyAdmin(familyId: string, personId: string, requesterId: string) {
  await getCommunityFamily(familyId)

  // Only an existing admin of this family can promote.
  const { rows: [requester] } = await query<{ role: string }>(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, requesterId],
  )
  if (requester?.role !== 'admin') throw forbidden('Family admin access required')

  // The selected node must belong to this family and be owned (claimed).
  const { rows: [person] } = await query<{ id: string; full_name: string; claimed_by: string | null }>(
    `SELECT id, full_name, claimed_by FROM persons
     WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [personId, familyId],
  )
  if (!person) throw notFound('Person not found in this family')
  if (!person.claimed_by) {
    throw badRequest(`${person.full_name} has not joined Ancestree yet — only owned profiles can become admins`)
  }
  const targetUserId = person.claimed_by

  await withOperation({ action: 'family.add_admin', actorId: requesterId, familyId }, async op => {
    const { rows: [existing] } = await op.tx.query<Snapshot>(
      `SELECT * FROM family_members WHERE family_id = $1 AND user_id = $2 FOR UPDATE`,
      [familyId, targetUserId],
    )
    if (existing) {
      if (existing.role === 'admin') return // already an admin — idempotent
      const { rows: [after] } = await op.tx.query<Snapshot>(
        `UPDATE family_members SET role = 'admin' WHERE family_id = $1 AND user_id = $2 RETURNING *`,
        [familyId, targetUserId],
      )
      await writeAudit(op, {
        entityType: 'family_member',
        entityId: String(targetUserId),
        before: existing,
        after,
      })
    } else {
      const { rows: [created] } = await op.tx.query<Snapshot>(
        `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'admin') RETURNING *`,
        [familyId, targetUserId],
      )
      await auditCreate(op, 'family_member', created)
    }
  })

  logger.info({ familyId, personId, targetUserId, requesterId }, 'family admin added')
  return { success: true, user_id: targetUserId, full_name: person.full_name }
}
