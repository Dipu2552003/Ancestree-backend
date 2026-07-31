// Graded write-scope enforcement for community access levels (see
// docs/ACCESS_LEVELS.md). Callers are already confined to a cluster by their
// JWT familyId (or an admin-swapped one via actAsFamily); this narrows *within*
// that for the lower levels:
//   Viewer(0)        — no writes, except your own node.
//   Household(1)     — your own node + nodes in a home you belong to.
//   Family Editor(2) — the whole cluster (today's behaviour) → no extra check.
// Levels don't apply to personal (non-community) trees.

import { query } from '../utils/db'
import { forbidden } from '../utils/errors'
import { LEVEL } from '../utils/accessLevels'

/** Pure decision: may an actor at `level` write a target node, given whether it
 *  is their own node and whether it's a home-mate? (Cluster confinement is the
 *  caller's job — this only grades below Family Editor.) */
export function canWriteTarget(level: number, isOwnNode: boolean, isHomeMate: boolean): boolean {
  if (level >= LEVEL.FAMILY_EDITOR) return true
  if (isOwnNode) return true                        // baseline right at every level
  if (level === LEVEL.HOUSEHOLD) return isHomeMate
  return false                                      // Viewer, not own node
}

/** Actor's level in the community owning `familyId`, or null for a personal
 *  (non-community) tree where levels don't apply. */
export async function communityLevelForFamily(familyId: string, userId: string): Promise<number | null> {
  const { rows: [row] } = await query<{ level: number }>(
    `SELECT cm.level
     FROM   families f
     JOIN   community_members cm ON cm.community_id = f.community_id AND cm.user_id = $2
     WHERE  f.id = $1 AND f.community_id IS NOT NULL`,
    [familyId, userId],
  )
  return row ? row.level : null
}

async function isOwnNode(userId: string, personId: string): Promise<boolean> {
  const { rows: [p] } = await query<{ claimed_by: string | null }>(
    `SELECT claimed_by FROM persons WHERE id = $1`, [personId],
  )
  return !!p && p.claimed_by === userId
}

/** True if the target person shares a (non-deleted) home with the actor. */
async function isHomeMate(userId: string, personId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1
     FROM   home_members me
     JOIN   home_members tgt ON tgt.home_id = me.home_id AND tgt.deleted_at IS NULL
     WHERE  me.deleted_at IS NULL
       AND  me.person_id = (SELECT person_id FROM users WHERE id = $1)
       AND  tgt.person_id = $2
     LIMIT  1`,
    [userId, personId],
  )
  return rows.length > 0
}

function denyMessage(level: number): string {
  return level <= LEVEL.VIEWER
    ? 'Your access is view-only'
    : 'You can only edit members of your own home'
}

/** Guard a write that targets an existing person. No-op for personal trees and
 *  Family Editor+. */
export async function assertPersonWriteScope(userId: string, familyId: string, personId: string): Promise<void> {
  const level = await communityLevelForFamily(familyId, userId)
  if (level === null || level >= LEVEL.FAMILY_EDITOR) return
  const own  = await isOwnNode(userId, personId)
  const mate = level === LEVEL.HOUSEHOLD ? await isHomeMate(userId, personId) : false
  if (!canWriteTarget(level, own, mate)) throw forbidden(denyMessage(level))
}

/** Guard node creation (no existing target). Viewer is blocked; Household+ may
 *  create — Household is then constrained when it links the node (relationship). */
export async function assertCanCreate(userId: string, familyId: string): Promise<void> {
  const level = await communityLevelForFamily(familyId, userId)
  if (level !== null && level < LEVEL.HOUSEHOLD) throw forbidden('Your access is view-only')
}

/** Guard a relationship write. Household needs at least one endpoint that is
 *  their own node or a home-mate (so they can only wire up their household). */
export async function assertRelationWriteScope(userId: string, familyId: string, personIds: string[]): Promise<void> {
  const level = await communityLevelForFamily(familyId, userId)
  if (level === null || level >= LEVEL.FAMILY_EDITOR) return
  if (level < LEVEL.HOUSEHOLD) throw forbidden('Your access is view-only')
  for (const pid of personIds) {
    if (await isOwnNode(userId, pid) || await isHomeMate(userId, pid)) return
  }
  throw forbidden('You can only add relations within your own home')
}

/** Bulk edit is a Family Editor+ (cluster-wide) capability. */
export async function assertCanBulkEdit(userId: string, familyId: string): Promise<void> {
  const level = await communityLevelForFamily(familyId, userId)
  if (level !== null && level < LEVEL.FAMILY_EDITOR) {
    throw forbidden('Your access level does not permit bulk editing')
  }
}

// Runnable check: npx ts-node src/services/writeScope.ts
if (require.main === module) {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error('FAIL: ' + m) }
  assert(canWriteTarget(LEVEL.VIEWER, true,  false) === true,  'viewer own node')
  assert(canWriteTarget(LEVEL.VIEWER, false, true)  === false, 'viewer home-mate blocked')
  assert(canWriteTarget(LEVEL.HOUSEHOLD, false, true)  === true,  'household home-mate')
  assert(canWriteTarget(LEVEL.HOUSEHOLD, false, false) === false, 'household stranger blocked')
  assert(canWriteTarget(LEVEL.HOUSEHOLD, true,  false) === true,  'household own node')
  assert(canWriteTarget(LEVEL.FAMILY_EDITOR, false, false) === true, 'family editor cluster')
  assert(canWriteTarget(LEVEL.ADMIN, false, false) === true, 'admin')
  console.log('writeScope decision checks passed')
}
