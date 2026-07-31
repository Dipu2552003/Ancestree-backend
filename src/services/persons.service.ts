import crypto from 'crypto'
import { query, defaultRunner, type QueryRunner } from '../utils/db'
import { withOperation, captureAndUpdate, auditCreate } from '../utils/audit'
import { CreatePersonInput, UpdatePersonInput } from '../schemas/person.schema'
import { searchDuplicates } from './merge'
import { findSameTreeDuplicates } from './duplicates/sameTreeMatch'
import { createPossibleMatchNotification } from './notification.service'
import { logger } from '../utils/logger'
import { badRequest, forbidden, notFound } from '../utils/errors'
import * as personsRepo from '../repositories/persons.repo'
import { recomputeHeads } from './familyHead.service'
import * as relsRepo from '../repositories/relationships.repo'
import { assertPersonWriteScope, assertCanCreate, assertCanBulkEdit } from './writeScope'

// NOTE: the person_code_seq bump is deliberately NOT audited — it is a
// monotonic counter and undoing it would hand out already-used (UNIQUE)
// person codes. See src/utils/audit.ts header.
async function nextPersonCode(familyId: string, runner: QueryRunner = defaultRunner): Promise<string> {
  const { rows: [fam] } = await runner.query<{ name_prefix: string; person_code_seq: number }>(
    `UPDATE families
     SET person_code_seq = person_code_seq + 1
     WHERE id = $1
     RETURNING name_prefix, person_code_seq`,
    [familyId]
  )
  const seq = String(fam.person_code_seq).padStart(3, '0')
  return `${fam.name_prefix}-${seq}`
}

// Community "constant" fields → fixed column values stamped onto NEW nodes only
// (Option B: existing nodes are never rewritten — the editor just displays the
// constant). Only constants that map to a create-time column input are honored
// here; others (e.g. religion) rely on their column default until added as an
// explicit create param.
async function communityConstantColumns(
  communityId: string,
  runner: QueryRunner,
): Promise<Record<string, string>> {
  const { rows: [row] } = await runner.query<{
    settings: { fields?: Record<string, { type?: string; storage?: string; value?: string }> } | null
  }>(`SELECT settings FROM communities WHERE id = $1`, [communityId])
  const fields = row?.settings?.fields ?? {}
  const out: Record<string, string> = {}
  for (const [col, rule] of Object.entries(fields)) {
    if (rule?.type === 'constant' && (rule.storage ?? 'column') === 'column' && rule.value) {
      out[col] = rule.value
    }
  }
  return out
}

export async function createPerson(
  input: CreatePersonInput,
  userId: string,
  familyId: string
) {
  await assertCanCreate(userId, familyId)   // Viewer(0) can't create nodes
  const person = await withOperation(
    { action: 'person.create', actorId: userId, familyId },
    async op => {
      // Look up the family's community so the person inherits the right scope
      const { rows: [fam] } = await op.tx.query<{ community_id: string | null }>(
        `SELECT community_id FROM families WHERE id = $1`,
        [familyId],
      )
      const communityId = fam?.community_id ?? null
      // Community families default person visibility to 'community', not 'family'
      const effectiveVisibility = communityId != null
        ? 'community'
        : (input.visibility ?? 'family')

      // New-node constant autofill (Option B). Only fills a column the creator
      // left blank; never overrides a value they supplied.
      const constants = communityId ? await communityConstantColumns(communityId, op.tx) : {}
      const effLastName = input.last_name?.trim() ? input.last_name : (constants.last_name ?? null)

      const personCode = await nextPersonCode(familyId, op.tx)

      const { rows: [created] } = await op.tx.query(
        `INSERT INTO persons (
           person_code, primary_family_id, full_name, first_name, last_name,
           nickname, gender, birth_year, birth_place,
           death_year, is_alive, bio, occupation, photo_url, visibility,
           current_city, current_state, current_country, native_village, gotra, education,
           node_state, created_by, community_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
           'proxy',$22,$23
         ) RETURNING *`,
        [
          personCode, familyId, input.full_name, input.first_name ?? null, effLastName,
          input.nickname ?? null, input.gender ?? null,
          input.birth_year ?? null, input.birth_place ?? null, input.death_year ?? null,
          input.is_alive ?? true, input.bio ?? null, input.occupation ?? null,
          input.photo_url ?? null, effectiveVisibility,
          input.current_city ?? null, input.current_state ?? null, input.current_country ?? null,
          input.native_village ?? null, input.gotra ?? null, input.education ?? null,
          userId, communityId,
        ],
      )

      await auditCreate(op, 'person', created)
      return created
    },
  )

  logger.info({ personId: person.id, familyId, name: input.full_name }, 'person created')

  // Refresh cluster head + the new node's lineage head (itself until a PARENT_OF
  // edge is added).
  await recomputeHeads(familyId)

  const potential_matches = await searchDuplicates({
    fullName:      input.full_name,
    firstName:     input.first_name ?? null,
    lastName:      input.last_name ?? null,
    birthYear:     input.birth_year ?? null,
    nativeVillage: input.native_village ?? null,
    gotra:         input.gotra ?? null,
    gender:        input.gender ?? null,
  }, familyId).catch(err => {
    logger.error({ err }, 'duplicate search failed')
    return []
  })

  // Persist each match as a notification so the user can act on it later
  await Promise.allSettled(potential_matches.map(m =>
    createPossibleMatchNotification(userId, person.id, {
      new_person_name:           input.full_name,
      new_person_birth_year:     input.birth_year ?? null,
      new_person_native_village: input.native_village ?? null,
      new_person_gotra:          input.gotra ?? null,
      new_person_photo_url:      input.photo_url ?? null,
      canonical_person_id:       m.id,
      canonical_person_name:     m.full_name,
      canonical_family_id:       m.family_id,
      canonical_family_name:     m.family_name,
      match_score:               m.match_score,
      matched_fields:            m.matched_fields,
    }).catch(err => logger.error({ err }, 'possible_match notification failed'))
  ))

  // Same-family duplicate check (separate heuristic from the cross-family
  // search above): does a node with this name already exist in this tree?
  const same_tree_matches = await findSameTreeDuplicates({
    fullName:  input.full_name,
    gotra:     input.gotra ?? null,
    birthYear: input.birth_year ?? null,
    gender:    input.gender ?? null,
  }, familyId, person.id).catch(err => {
    logger.error({ err }, 'same-tree duplicate search failed')
    return []
  })

  return { ...person, potential_matches, same_tree_matches }
}

export async function getPersonById(id: string, familyId: string) {
  const { rows: [person] } = await query(
    `SELECT * FROM persons WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId]
  )
  if (!person) throw notFound('Person not found')
  return person
}

export async function updatePerson(
  id: string,
  input: UpdatePersonInput,
  userId: string,
  familyId: string
) {
  const person = await getPersonById(id, familyId)

  // Access-level scope (Viewer/Household) — no-op for Family Editor+.
  await assertPersonWriteScope(userId, familyId, id)

  if (person.node_state === 'claimed' && person.claimed_by !== userId) {
    logger.warn({ personId: id, userId, claimedBy: person.claimed_by }, 'updatePerson: forbidden')
    throw forbidden('Only the profile owner can edit a claimed profile')
  }

  const allowed = [
    'full_name', 'first_name', 'middle_name', 'last_name',
    'nickname', 'gender', 'religion',
    'birth_date', 'birth_year', 'birth_place',
    'death_date', 'death_year', 'death_place',
    'is_alive', 'bio', 'occupation', 'occupation_detail',
    'photo_url', 'photo_thumbnail_url', 'visibility',
    'phone', 'whatsapp', 'email',
    'current_address', 'current_city', 'current_district', 'current_state', 'current_country', 'current_pincode',
    'native_village', 'native_tehsil', 'native_district', 'native_state', 'native_country',
    'gotra', 'education',
    'bio_mother_name', 'bio_father_name',
  ]

  const fields = Object.entries(input).filter(
    ([k, v]) => allowed.includes(k) && v !== undefined
  )
  if (fields.length === 0) throw badRequest('No valid fields to update')

  const setClauses = fields.map(([k], i) => `${k} = $${i + 1}`).join(', ')
  const values = fields.map(([, v]) => v)

  const updated = await withOperation(
    { action: 'person.update', actorId: userId, familyId },
    async op => {
      const { after } = await captureAndUpdate(op, 'person',
        { sql: 'id = $1 AND deleted_at IS NULL', params: [id] },
        { sql: `${setClauses}, updated_at = NOW()`, params: values },
      )
      if (after.length === 0) throw notFound('Person not found')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return after[0] as Record<string, any>
    },
  )

  // When the user explicitly sets a real name, check whether that person
  // already exists in another family's tree and return the matches so the
  // frontend can offer a merge request immediately.
  let potential_matches: import('./merge').PotentialMatch[] = []
  const newName = input.full_name?.trim() ?? ''
  if (newName && newName.toLowerCase() !== 'unknown') {
    potential_matches = await searchDuplicates({
      fullName:      newName,
      firstName:     updated.first_name ?? null,
      lastName:      updated.last_name ?? null,
      birthYear:     updated.birth_year ?? null,
      nativeVillage: updated.native_village ?? null,
      gotra:         updated.gotra ?? null,
      gender:        updated.gender ?? null,
    }, familyId).catch(() => [])

    await Promise.allSettled(potential_matches.map(m =>
      createPossibleMatchNotification(userId, updated.id, {
        new_person_name:           newName,
        new_person_birth_year:     updated.birth_year ?? null,
        new_person_native_village: updated.native_village ?? null,
        new_person_gotra:          updated.gotra ?? null,
        new_person_photo_url:      updated.photo_url ?? null,
        canonical_person_id:       m.id,
        canonical_person_name:     m.full_name,
        canonical_family_id:       m.family_id,
        canonical_family_name:     m.family_name,
        match_score:               m.match_score,
        matched_fields:            m.matched_fields,
      }).catch(err => console.error('possible_match notification failed:', err))
    ))
  }

  logger.info({ personId: id, userId, fields: fields.map(([k]) => k) }, 'person updated')
  return { ...updated, potential_matches }
}

export async function generateInviteToken(id: string, userId: string, familyId: string) {
  const person = await getPersonById(id, familyId)
  await assertPersonWriteScope(userId, familyId, id)

  // 'invited' is allowed too, so a fresh code can be re-issued when the original
  // is lost — and after an invite expires back to 'proxy' it can be sent again.
  // Only a 'claimed' node (already owned) can't be invited.
  if (person.node_state !== 'proxy' && person.node_state !== 'invited') {
    throw badRequest('Only unclaimed nodes can be invited')
  }
  if (!person.is_alive) {
    throw badRequest('Cannot invite a deceased person')
  }

  const token = crypto.randomBytes(4).toString('hex').toUpperCase()

  await withOperation(
    { action: 'person.invite', actorId: userId, familyId },
    op => captureAndUpdate(op, 'person',
      { sql: 'id = $1', params: [id] },
      { sql: `invite_token = $1, node_state = 'invited', invite_sent_at = NOW(), updated_at = NOW()`, params: [token] },
    ),
  )

  logger.info({ personId: id, userId, familyId }, 'invite token generated')
  return { invite_token: token }
}

// ── Bloodline bulk edit (admin) ──────────────────────────────────────────────

/** True if the user is a family admin of the given family. */
async function isFamilyAdmin(familyId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ role: string }>(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId],
  )
  return rows[0]?.role === 'admin'
}

/** True if the user is the owner or an admin of the given community. */
async function isCommunityAdmin(communityId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2`,
    [communityId, userId],
  )
  return rows[0]?.role === 'owner' || rows[0]?.role === 'admin'
}

// Two admin bulk-edit flows share this path:
//   • 'bloodline' — a paternal line resolved automatically (gotra/village are
//     patrilineal, so a whole line shares them).
//   • 'selection' — an ad-hoc set of people the admin hand-picked; may also set
//     current location, which is per-person and so has no place in a bloodline.
export type BulkScope = 'bloodline' | 'selection'

// Columns each scope is allowed to touch. Everything not listed is ignored even
// if sent, so the endpoint can never become a general person-editor.
const BULK_FIELDS: Record<BulkScope, readonly string[]> = {
  bloodline: ['gotra', 'native_village'],
  selection: ['gotra', 'native_village', 'current_city', 'current_district', 'current_state', 'current_country'],
}

/**
 * Bulk-set a small set of fields on a set of person ids the caller resolved on
 * the graph (bloodline BFS or a manual multi-select — see lib/graph/bloodline
 * and the selection UI on the frontend). Recorded as ONE operation so a single
 * undo reverts the entire change.
 *
 * Scope + auth: every target must live in the same family; the caller must be a
 * family admin of that family, or an owner/admin of its community.
 */
export async function bulkUpdatePersons(
  personIds: string[],
  scope: BulkScope,
  changes: Record<string, string | undefined>,
  userId: string,
) {
  const allowedCols = BULK_FIELDS[scope]
  const setEntries = allowedCols
    .filter(k => typeof changes[k] === 'string' && changes[k]!.trim().length > 0)
    .map(k => [k, changes[k]!.trim()] as const)
  if (setEntries.length === 0) throw badRequest('Choose at least one field to apply')

  // Resolve the targets — must exist, not be deleted, and share one family.
  const { rows: targets } = await query<{ id: string; primary_family_id: string; community_id: string | null }>(
    `SELECT id, primary_family_id, community_id
     FROM   persons
     WHERE  id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [personIds],
  )
  if (targets.length === 0) throw notFound('No matching people to update')
  const familyIds = new Set(targets.map(t => t.primary_family_id))
  if (familyIds.size > 1) throw badRequest('A bulk selection must belong to a single family')
  const familyId    = targets[0].primary_family_id
  const communityId = targets[0].community_id

  // Auth: family admin OR community owner/admin.
  const allowed =
    (await isFamilyAdmin(familyId, userId)) ||
    (communityId ? await isCommunityAdmin(communityId, userId) : false)
  if (!allowed) throw forbidden('Only a family or community admin can bulk-edit people')
  // Access level: bulk edit is a Family Editor+ (cluster-wide) capability.
  await assertCanBulkEdit(userId, familyId)

  const ids = targets.map(t => t.id)
  const setClauses = setEntries.map(([k], i) => `${k} = $${i + 1}`).join(', ')
  const values     = setEntries.map(([, v]) => v)

  // Distinct history action per scope so the summary + undo track read right.
  const action = scope === 'bloodline' ? 'person.bloodline_update' : 'person.bulk_update'

  const { after } = await withOperation(
    { action, actorId: userId, familyId },
    op => captureAndUpdate(op, 'person',
      { sql: 'id = ANY($1::uuid[]) AND deleted_at IS NULL', params: [ids] },
      { sql: `${setClauses}, updated_at = NOW()`, params: values },
    ),
  )

  logger.info(
    { userId, familyId, scope, count: after.length, fields: setEntries.map(([k]) => k) },
    'bulk person update',
  )
  return { updated: after.length, family_id: familyId, fields: setEntries.map(([k]) => k) }
}

/** Connected-component count over the given person ids and edges. */
function countComponents(ids: Set<string>, edges: { from_person_id: string; to_person_id: string }[]): number {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!ids.has(e.from_person_id) || !ids.has(e.to_person_id)) continue
    if (!adj.has(e.from_person_id)) adj.set(e.from_person_id, [])
    if (!adj.has(e.to_person_id))   adj.set(e.to_person_id, [])
    adj.get(e.from_person_id)!.push(e.to_person_id)
    adj.get(e.to_person_id)!.push(e.from_person_id)
  }
  const seen = new Set<string>()
  let components = 0
  for (const start of ids) {
    if (seen.has(start)) continue
    components++
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
    }
  }
  return components
}

/** True when removing `personId` (and its incident edges) would split the
 *  family graph into more disconnected pieces than it has today. */
async function wouldDisconnectFamily(personId: string, familyId: string): Promise<boolean> {
  const { rows: people } = await query<{ id: string }>(
    `SELECT id FROM persons WHERE primary_family_id = $1 AND deleted_at IS NULL`,
    [familyId],
  )
  const { rows: edges } = await query<{ from_person_id: string; to_person_id: string }>(
    `SELECT from_person_id, to_person_id FROM relationships
     WHERE primary_family_id = $1 AND deleted_at IS NULL`,
    [familyId],
  )

  const all = new Set<string>(people.map(p => p.id))
  if (!all.has(personId)) return false

  const remaining = new Set(all)
  remaining.delete(personId)
  if (remaining.size === 0) return false

  // Compare component counts instead of asserting full connectivity, so a
  // graph that is already split (legacy data) doesn't block every delete.
  const before = countComponents(all, edges)
  const after  = countComponents(remaining, edges)
  // Removing an edge node keeps the count (or lowers it when the node was
  // isolated); removing a bridge raises it.
  return after > before
}

export async function deletePerson(id: string, userId: string, familyId: string) {
  const person = await getPersonById(id, familyId)
  await assertPersonWriteScope(userId, familyId, id)

  if (person.claimed_by === userId) {
    logger.warn({ personId: id, userId }, 'deletePerson: tried to delete own node')
    throw forbidden('You cannot delete your own node')
  }

  // R-A1 (connectivity): a person may be deleted only if removing them does
  // not break the tree apart — i.e. they are not the bridge between parts of
  // the family. Edge nodes pass (top ancestors, leaf children, childless
  // spouses — and a parent whose children stay connected through the other
  // parent). Someone like a father who is the only link between his parents
  // and his children is blocked.
  const splits = await wouldDisconnectFamily(id, familyId)
  if (splits) {
    throw badRequest(
      `Cannot remove ${person.full_name} — they connect other family members to the tree. Remove the people connected through them first.`
    )
  }

  await withOperation({ action: 'person.delete', actorId: userId, familyId }, async op => {
    // Remove edges that attach this person to their parents' family unit:
    //   1. PARENT_OF inbound — parents → this person
    //   2. SIBLING_OF (any direction)
    //   3. SPOUSE_OF (any direction)
    //   4. PARENT_OF outbound — this person → their children
    await relsRepo.softDeleteInboundByType(id, 'PARENT_OF', op)
    await relsRepo.softDeleteForPersonByType(id, 'SIBLING_OF', op)
    await relsRepo.softDeleteForPersonByType(id, 'SPOUSE_OF', op)
    await relsRepo.softDeleteOutboundByType(id, 'PARENT_OF', op)

    const remaining = await relsRepo.countActiveForPerson(id, op.tx)
    const hasOwnFamily = remaining > 0

    // Only hard-delete the node if it is unclaimed AND has no remaining connections.
    // Claimed nodes are never deleted — the account owner still exists.
    // Proxy/invited nodes with a spouse or children stay as their own family unit.
    const softDeleted = !hasOwnFamily && person.node_state !== 'claimed'
    if (softDeleted) {
      await personsRepo.softDelete(id, op)

      // If that was the family's last living node, retire the now-empty family
      // too (soft-delete) so it doesn't linger as an orphan tree.
      const { rows: [{ n }] } = await op.tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM persons WHERE primary_family_id = $1 AND deleted_at IS NULL`,
        [familyId],
      )
      if (n === 0) {
        // Audited so undoing the person delete also restores the family.
        await captureAndUpdate(
          op, 'family',
          { sql: 'id = $1 AND deleted_at IS NULL', params: [familyId] },
          { sql: `deleted_at = NOW(), updated_at = NOW()`, params: [] },
          { familyId, snapshotCols: 'id, deleted_at' },
        )
        logger.info({ familyId, personId: id }, 'family auto-deleted — no nodes remained')
      }
    } else {
      logger.warn({ personId: id, userId, hasOwnFamily, nodeState: person.node_state }, 'person node kept — relationships removed only')
    }

    logger.info({ personId: id, userId, softDeleted }, 'person deleted')
  })

  // Deleting a person can split a lineage (e.g. removing a father orphans his
  // children into their own patrilines) and change the topmost ancestor —
  // re-stamp cluster + lineage heads.
  await recomputeHeads(familyId)

  return { success: true }
}
