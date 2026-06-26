// Phase 1 safety net — history view + undo.
//
// undoOperation() reverses a whole operation: it reads every audit row for an
// operation_id newest-first (seq DESC) and restores each row's before-state —
// re-create deleted rows, remove created rows, revert updated rows. The undo
// runs inside its own withOperation() envelope so it is fully logged, but it
// can NOT itself be undone — reverts are one-shot, settled for every family
// involved the moment anyone performs them. History is never deleted.

import { query } from '../utils/db'
import {
  withOperation, writeAudit, captureAndDelete, captureAndUpdate, ENTITY_TABLES,
  type EntityType, type OperationContext, type Snapshot,
} from '../utils/audit'
import { logger } from '../utils/logger'
import { notFound, forbidden, conflict, badRequest } from '../utils/errors'

interface AuditRow {
  id: string
  operation_id: string
  seq: string
  family_id: string | null
  actor_id: string | null
  action: string
  entity_type: EntityType
  entity_id: string
  before_state: Snapshot | null
  after_state: Snapshot | null
  created_at: string
  reverted_by: string | null
}

// Snapshot keys come from our own `RETURNING *` captures, so they are real
// column names — but they are interpolated into SQL, so guard anyway.
const IDENT = /^[a-z_][a-z0-9_]*$/
function assertIdent(name: string): void {
  if (!IDENT.test(name)) throw badRequest(`Unsafe identifier in snapshot: ${name}`)
}

// ── Revert primitives ─────────────────────────────────────────────────────────

/**
 * A person row is the target of several NON-cascading foreign keys. Undoing a
 * `person.create` hard-deletes the person, but the links to that person were
 * added by *separate* operations (the add-relation wizard, the merge-from-search
 * flow, duplicate-match notifications), so they are still present and Postgres
 * rejects the DELETE unless we clear them first.
 *
 *   relationships.from/to_person_id        — links to parents/children/spouses
 *   merge_records.canonical/merged_person_id — a merge proxy's pending request
 *   notifications.merge_record_id          — FK to those merge_records
 *   notifications.related_person_id        — possible-match notifications
 *   families.head_person_id                — derived pointer, recomputed anyway
 *
 * relationships, merge_records and the family-head reset are captured + audited
 * under the undo operation. notifications are derived side-effects and are not
 * audited (see utils/audit.ts header), so they are removed with a plain DELETE.
 */
async function clearPersonReferences(
  op: OperationContext,
  personId: string,
  familyId: string | null,
): Promise<void> {
  // 1. Relationships touching the person in either direction.
  await captureAndDelete(op, 'relationship', {
    sql: 'from_person_id = $1 OR to_person_id = $1',
    params: [personId],
  }, { familyId })

  // 2. Merge records referencing the person — their notifications must go first
  //    (notifications.merge_record_id is a non-cascading FK).
  const { rows: mergeRecords } = await op.tx.query<{ id: string }>(
    `SELECT id FROM merge_records WHERE canonical_person_id = $1 OR merged_person_id = $1`,
    [personId],
  )
  if (mergeRecords.length > 0) {
    await op.tx.query(
      `DELETE FROM notifications WHERE merge_record_id = ANY($1::uuid[])`,
      [mergeRecords.map(r => r.id)],
    )
    await captureAndDelete(op, 'merge_record', {
      sql: 'canonical_person_id = $1 OR merged_person_id = $1',
      params: [personId],
    }, { familyId })
  }

  // 3. Possible-match notifications pointing straight at the person.
  await op.tx.query(
    `DELETE FROM notifications WHERE related_person_id = $1`,
    [personId],
  )

  // 4. Family head pointer — derived (recomputed after merges); null it if it
  //    happened to reference this person so the delete (and commit) succeed.
  await captureAndUpdate(op, 'family',
    { sql: 'head_person_id = $1', params: [personId] },
    { sql: 'head_person_id = NULL' },
  )
}

/** Undo a 'create': delete the row that the operation inserted. */
async function revertCreate(op: OperationContext, row: AuditRow): Promise<void> {
  const snapshot = row.after_state as Snapshot
  if (row.entity_type === 'family_member') {
    await captureAndDelete(op, 'family_member', {
      sql: 'family_id = $1 AND user_id = $2',
      params: [snapshot.family_id, snapshot.user_id],
    }, { familyId: row.family_id })
    return
  }
  // A person is referenced by non-cascading FKs — clear them before the hard
  // delete below, or Postgres rejects it. (Only person.create reaches here with
  // a person; merge/delete undos revert persons via revertUpdate instead.)
  if (row.entity_type === 'person') {
    await clearPersonReferences(op, row.entity_id, row.family_id)
  }
  await captureAndDelete(op, row.entity_type as Exclude<EntityType, 'operation'>, {
    sql: 'id = $1',
    params: [row.entity_id],
  }, { familyId: row.family_id })
}

/** Undo a 'delete': re-insert the row exactly as it was (same id, timestamps). */
async function revertDelete(op: OperationContext, row: AuditRow): Promise<void> {
  const table = ENTITY_TABLES[row.entity_type as Exclude<EntityType, 'operation'>]
  const { rows: [restored] } = await op.tx.query<Snapshot>(
    `INSERT INTO ${table}
     SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)
     RETURNING *`,
    [JSON.stringify(row.before_state)],
  )
  await writeAudit(op, {
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: null,
    after: restored,
    familyId: row.family_id,
  })
}

/** Undo an 'update': restore exactly the columns captured in before_state. */
async function revertUpdate(op: OperationContext, row: AuditRow): Promise<void> {
  const table = ENTITY_TABLES[row.entity_type as Exclude<EntityType, 'operation'>]
  const snapshot = row.before_state as Snapshot
  const keys = Object.keys(snapshot)
  keys.forEach(assertIdent)
  const setCols = keys.filter(k => k !== 'id')
  if (setCols.length === 0) return

  // Capture the current values of the same columns for the undo's own log
  // entry (partial snapshots — e.g. users — stay partial here too).
  const { rows: [current] } = await op.tx.query<Snapshot>(
    `SELECT ${keys.join(', ')} FROM ${table} WHERE id = $1 FOR UPDATE`,
    [row.entity_id],
  )

  if (!current) {
    // The row was hard-deleted by a later operation; restore it outright.
    logger.warn({ table, entityId: row.entity_id }, 'undo: row missing, re-inserting before_state')
    await revertDelete(op, row)
    return
  }

  const sets = setCols.map(c => `${c} = s.${c}`).join(', ')
  const { rows: [after] } = await op.tx.query<Snapshot>(
    `UPDATE ${table} t SET ${sets}
     FROM jsonb_populate_record(NULL::${table}, $1::jsonb) s
     WHERE t.id = $2
     RETURNING ${keys.map(k => `t.${k}`).join(', ')}`,
    [JSON.stringify(snapshot), row.entity_id],
  )
  await writeAudit(op, {
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: current,
    after,
    familyId: row.family_id,
  })
}

// Only headline operations appear in the user-facing timeline: adding a
// person and accepting a merge. Everything else (field edits, relationship
// tweaks, invites, …) is still fully audited for the safety net — it just
// stays out of the panel. Undo operations are filtered out too: the original
// entry shows an "Undone" badge instead, and hiding them means an undo can
// never be re-undone from the UI (one-shot revert).
const VISIBLE_ACTIONS = ['person.create', 'merge.accept']

/** A family admin (the family's owner/manager) may undo any member's action. */
async function isFamilyAdmin(familyId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ role: string }>(
    `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId],
  )
  return rows[0]?.role === 'admin'
}

/**
 * The single operation that may be undone next in this family: the most recent
 * un-reverted, user-visible operation. Undo is strictly newest-first — only
 * this operation is undoable, never one from the middle of the history.
 */
async function topUndoableOperationId(familyId: string): Promise<string | null> {
  const { rows } = await query<{ operation_id: string }>(
    `SELECT operation_id FROM (
       SELECT operation_id,
              (ARRAY_AGG(action      ORDER BY seq))[1] AS action,
              (ARRAY_AGG(reverted_by ORDER BY seq))[1] AS reverted_by,
              MIN(seq)                                 AS min_seq
       FROM   audit_log
       WHERE  family_id = $1
       GROUP  BY operation_id
     ) g
     WHERE  g.action = ANY($2::text[])
       AND  g.reverted_by IS NULL
     ORDER  BY g.min_seq DESC
     LIMIT  1`,
    [familyId, VISIBLE_ACTIONS],
  )
  return rows[0]?.operation_id ?? null
}

// ── Undo ──────────────────────────────────────────────────────────────────────

export async function undoOperation(operationId: string, userId: string, familyId: string) {
  const { rows } = await query<AuditRow>(
    `SELECT * FROM audit_log WHERE operation_id = $1 ORDER BY seq DESC`,
    [operationId],
  )
  if (rows.length === 0) throw notFound('Operation not found')
  if (!rows.some(r => r.family_id === familyId)) {
    throw forbidden('This operation does not belong to your family')
  }
  if (rows.some(r => r.reverted_by !== null)) {
    throw conflict('This operation has already been undone')
  }

  const targetAction = rows[rows.length - 1].action // lowest seq

  // Undo is one-shot: an undo operation can never itself be undone. Without
  // this, two families could ping-pong a merge forever (A undoes the merge,
  // B undoes the undo, A undoes that, …). Whoever reverts first wins; after
  // that the operation is settled for both sides.
  if (targetAction === 'undo' || targetAction.startsWith('undo:')) {
    throw conflict('An undo cannot be reverted')
  }

  // Permission: only the member who performed the action — or a family admin —
  // may undo it. (The UI also hides the control from everyone else.)
  const actorId = rows[rows.length - 1].actor_id // operation initiator (lowest seq)
  const admin   = await isFamilyAdmin(familyId, userId)
  if (actorId !== userId && !admin) {
    throw forbidden('Only the person who made this change, or a family admin, can undo it')
  }

  // Order: undo is newest-first only. The target must be the most recent
  // un-reverted operation in this family — no undoing from the middle.
  const topId = await topUndoableOperationId(familyId)
  if (topId !== operationId) {
    throw conflict('Undo the most recent change first — actions can only be undone in order')
  }

  const result = await withOperation({ action: 'undo', actorId: userId, familyId }, async op => {
    let reverted = 0
    for (const row of rows) {
      if (row.entity_type === 'operation') continue // marker rows have no table
      if (row.before_state === null && row.after_state === null) continue
      if (row.before_state === null)      await revertCreate(op, row)
      else if (row.after_state === null)  await revertDelete(op, row)
      else                                await revertUpdate(op, row)
      reverted++
    }

    // Marker row: records WHICH operation this undo reverted (used by the
    // history summary; skipped by any future undo-of-this-undo).
    await writeAudit(op, {
      entityType: 'operation',
      entityId: operationId,
      before: null,
      after: null,
      action: `undo:${targetAction}`,
    })

    // Mark the target operation as reverted by this undo. History is never
    // deleted — the original rows stay, only the pointer is stamped.
    await op.tx.query(
      `UPDATE audit_log SET reverted_by = $1 WHERE operation_id = $2`,
      [op.operationId, operationId],
    )
    // If the target was itself an undo, whatever IT had reverted is now back
    // in effect — clear that pointer so the chain stays consistent.
    await op.tx.query(
      `UPDATE audit_log SET reverted_by = NULL WHERE reverted_by = $1`,
      [operationId],
    )

    return { undone_operation_id: operationId, undo_operation_id: op.operationId, reverted_entries: reverted }
  })

  logger.info({ ...result, userId, familyId, targetAction }, 'operation undone')
  return result
}

// ── History view ──────────────────────────────────────────────────────────────

const REL_LABELS: Record<string, string> = {
  PARENT_OF:  'parent–child',
  SPOUSE_OF:  'spouse',
  SIBLING_OF: 'sibling',
}

interface HistoryEntrySlim {
  operation_id: string
  action: string
  entity_type: EntityType
  before_state: Snapshot | null
  after_state: Snapshot | null
}

function summarize(action: string, entries: HistoryEntrySlim[]): string {
  const personEntry = entries.find(e =>
    e.entity_type === 'person' &&
    ((e.after_state?.full_name as string) || (e.before_state?.full_name as string)),
  )
  const name = (personEntry?.after_state?.full_name ?? personEntry?.before_state?.full_name) as string | undefined

  const relEntry = entries.find(e => e.entity_type === 'relationship')
  const relType = (relEntry?.after_state?.rel_type ?? relEntry?.before_state?.rel_type) as string | undefined
  const relLabel = relType ? (REL_LABELS[relType] ?? relType) : 'family'

  if (action.startsWith('undo')) {
    const target = action.split(':')[1]
    return target ? `Reverted an earlier change (${target})` : 'Reverted an earlier change'
  }
  switch (action) {
    case 'person.create':       return name ? `Added ${name}` : 'Added a person'
    case 'person.update':       return name ? `Edited ${name}` : 'Edited a person'
    case 'person.delete':       return name ? `Removed ${name} from the tree` : 'Removed a person from the tree'
    case 'person.invite':       return name ? `Invited ${name}` : 'Sent an invite'
    case 'person.claim':        return name ? `${name} was claimed by its owner` : 'A node was claimed'
    case 'person.reparent':     return 'Re-assigned children to a different mother'
    case 'relationship.create': return `Added a ${relLabel} link`
    case 'relationship.update': return `Edited a ${relLabel} link`
    case 'relationship.delete': return `Removed a ${relLabel} link`
    case 'merge.request':       return 'Requested a merge of duplicate profiles'
    case 'merge.reject':        return 'Declined a merge request'
    case 'merge.accept':        return name ? `Merged a duplicate profile of ${name}` : 'Merged duplicate profiles'
    case 'family.create':       return 'Created the family'
    case 'family.update_head':  return 'Recalculated the family name'
    default:                    return action
  }
}

export interface HistoryOperation {
  operation_id: string
  action: string
  summary: string
  actor_id: string | null
  actor_name: string | null
  created_at: string
  entry_count: number
  reverted: boolean
  reverted_by: string | null
  /** This viewer performed the action. */
  is_actor: boolean
  /** This viewer may undo it right now (it is the newest un-reverted op and
   *  they are its actor or a family admin). Drives the active Undo button. */
  can_undo: boolean
  /** Undo is blocked for now — shown as a disabled "locked" state. */
  undo_locked: boolean
  /** Why it's locked: 'order' (a newer change must be undone first) or
   *  'owner' (it's next in line, but only its actor/an admin may undo it). */
  lock_reason: 'order' | 'owner' | null
}

export async function getFamilyHistory(familyId: string, userId: string, limit = 50): Promise<HistoryOperation[]> {
  const { rows: ops } = await query<{
    operation_id: string
    action: string
    actor_id: string | null
    reverted_by: string | null
    created_at: string
    entry_count: number
  }>(
    `SELECT operation_id, action, actor_id, reverted_by, created_at, entry_count
     FROM (
       SELECT operation_id,
              (ARRAY_AGG(action      ORDER BY seq))[1] AS action,
              (ARRAY_AGG(actor_id    ORDER BY seq))[1] AS actor_id,
              (ARRAY_AGG(reverted_by ORDER BY seq))[1] AS reverted_by,
              MIN(created_at)                          AS created_at,
              COUNT(*)::int                            AS entry_count,
              MIN(seq)                                 AS min_seq
       FROM   audit_log
       WHERE  family_id = $1
       GROUP  BY operation_id
     ) g
     WHERE  g.action = ANY($2::text[])
     ORDER  BY g.min_seq DESC
     LIMIT  $3`,
    [familyId, VISIBLE_ACTIONS, limit],
  )
  if (ops.length === 0) return []

  const opIds = ops.map(o => o.operation_id)
  const { rows: entries } = await query<HistoryEntrySlim>(
    `SELECT operation_id, action, entity_type, before_state, after_state
     FROM   audit_log
     WHERE  operation_id = ANY($1::uuid[])
     ORDER  BY seq ASC`,
    [opIds],
  )
  const entriesByOp = new Map<string, HistoryEntrySlim[]>()
  for (const e of entries) {
    const list = entriesByOp.get(e.operation_id) ?? []
    list.push(e)
    entriesByOp.set(e.operation_id, list)
  }

  const actorIds = Array.from(new Set(ops.map(o => o.actor_id).filter((a): a is string => a !== null)))
  const actorNames = new Map<string, string>()
  if (actorIds.length > 0) {
    const { rows: users } = await query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
      [actorIds],
    )
    for (const u of users) actorNames.set(u.id, u.display_name)
  }

  const isAdmin = await isFamilyAdmin(familyId, userId)
  // `ops` is ordered newest-first, so the first un-reverted entry is the only
  // operation that may be undone next (global newest-first stack).
  const topId = ops.find(o => o.reverted_by === null)?.operation_id ?? null

  // For undo operations, prefer the marker row's action ('undo:<target>') for
  // a more specific summary.
  return ops.map(o => {
    const opEntries = entriesByOp.get(o.operation_id) ?? []
    const marker = opEntries.find(e => e.entity_type === 'operation')
    const action = marker?.action ?? o.action

    const reverted = o.reverted_by !== null
    const isActor  = o.actor_id !== null && o.actor_id === userId
    const isTop    = o.operation_id === topId
    // Undoable now only if it's the newest un-reverted op AND the viewer owns
    // it (or is an admin). Otherwise it's locked: 'order' when a newer change
    // must go first, 'owner' when it's next but belongs to someone else.
    const canUndo    = !reverted && isTop && (isActor || isAdmin)
    const undoLocked = !reverted && !canUndo
    const lockReason: 'order' | 'owner' | null =
      !undoLocked ? null : (isTop ? 'owner' : 'order')

    return {
      operation_id: o.operation_id,
      action: o.action,
      summary: summarize(action, opEntries),
      actor_id: o.actor_id,
      actor_name: o.actor_id ? (actorNames.get(o.actor_id) ?? null) : null,
      created_at: o.created_at,
      entry_count: o.entry_count,
      reverted,
      reverted_by: o.reverted_by,
      is_actor: isActor,
      can_undo: canUndo,
      undo_locked: undoLocked,
      lock_reason: lockReason,
    }
  })
}
