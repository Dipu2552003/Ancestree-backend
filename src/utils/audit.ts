// Phase 1 safety net — operation log plumbing.
//
// Three pieces:
//   withOperation()  — wraps a user action in one transaction and stamps a
//                      shared operation_id on every audit row written inside.
//                      If anything throws, data AND logs roll back together.
//   writeAudit()     — the single path that inserts audit_log rows. Nothing
//                      else in the codebase may INSERT into audit_log.
//   capture helpers  — captureAndUpdate / captureAndDelete / auditCreate wrap
//                      the select-before → mutate → log-after pattern so call
//                      sites stay one-liners.
//
// Snapshot rules:
//   • before_state NULL  → the row was created   (undo: delete it)
//   • after_state  NULL  → the row was deleted   (undo: re-insert before_state)
//   • both present       → the row was updated   (undo: restore before_state keys)
//   Soft-deletes are recorded as updates (deleted_at flips), so the generic
//   update-revert restores them.
//
// Deliberately NOT audited:
//   • families.person_code_seq bumps — a monotonic counter; rewinding it on
//     undo would hand out already-used (UNIQUE) person codes.
//   • users account data (email, password_hash, reset tokens) — account
//     management, not family-tree data. Only users.person_id (graph pointer)
//     is snapshotted, via snapshotCols.
//   • notifications — derived side-effects, recreated by normal use.

import crypto from 'crypto'
import { withTransaction } from './transaction'
import { type QueryRunner } from './db'

export type Snapshot = Record<string, unknown>

export type EntityType =
  | 'person'
  | 'relationship'
  | 'family'
  | 'family_member'
  | 'merge_record'
  | 'user'
  | 'operation' // marker rows (e.g. which operation an undo reverted) — no table

export const ENTITY_TABLES: Record<Exclude<EntityType, 'operation'>, string> = {
  person:        'persons',
  relationship:  'relationships',
  family:        'families',
  family_member: 'family_members',
  merge_record:  'merge_records',
  user:          'users',
}

/** family_members has a composite PK; its audit identity is the user_id and the
 *  full composite key lives in the snapshot. Everything else keys on `id`. */
export function entityIdOf(entityType: EntityType, row: Snapshot): string {
  if (entityType === 'family_member') return String(row.user_id)
  return String(row.id)
}

export interface OperationContext {
  tx: QueryRunner
  operationId: string
  action: string
  actorId: string | null
  /** Mutable on purpose — some operations (merge accept) only learn their
   *  family scope mid-transaction, before any audit row is written. */
  familyId: string | null
}

export async function withOperation<T>(
  meta: { action: string; actorId?: string | null; familyId?: string | null },
  fn: (op: OperationContext) => Promise<T>,
): Promise<T> {
  return withTransaction(async tx => {
    const op: OperationContext = {
      tx,
      operationId: crypto.randomUUID(),
      action: meta.action,
      actorId: meta.actorId ?? null,
      familyId: meta.familyId ?? null,
    }
    return fn(op)
  })
}

export interface AuditEntry {
  entityType: EntityType
  entityId: string
  before: Snapshot | null
  after: Snapshot | null
  /** Defaults to the operation-level action. */
  action?: string
  /** Defaults to op.familyId. */
  familyId?: string | null
}

/** The one and only writer of audit_log rows. */
export async function writeAudit(op: OperationContext, entry: AuditEntry): Promise<void> {
  await op.tx.query(
    `INSERT INTO audit_log
       (operation_id, family_id, actor_id, action, entity_type, entity_id, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      op.operationId,
      entry.familyId !== undefined ? entry.familyId : op.familyId,
      op.actorId,
      entry.action ?? op.action,
      entry.entityType,
      entry.entityId,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
    ],
  )
}

/** Log a freshly-inserted row (caller already has it via RETURNING *). */
export async function auditCreate(
  op: OperationContext,
  entityType: EntityType,
  row: Snapshot,
  opts?: { action?: string; familyId?: string | null },
): Promise<void> {
  await writeAudit(op, {
    entityType,
    entityId: entityIdOf(entityType, row),
    before: null,
    after: row,
    ...opts,
  })
}

interface SqlFragment {
  /** WHERE / SET body with $1-based placeholders numbering ONLY its own params. */
  sql: string
  params?: unknown[]
}

/**
 * Audited bulk update: SELECT … FOR UPDATE → UPDATE … RETURNING → one audit
 * row per affected row. `where` and `set` each use their own $1-based
 * numbering; this function renumbers internally.
 *
 * Returns the before/after snapshots so callers can branch on them
 * (e.g. rowCount checks, reading captured columns).
 */
export async function captureAndUpdate(
  op: OperationContext,
  entityType: Exclude<EntityType, 'operation' | 'family_member'>,
  where: SqlFragment,
  set: SqlFragment,
  opts?: { action?: string; familyId?: string | null; snapshotCols?: string },
): Promise<{ before: Snapshot[]; after: Snapshot[] }> {
  const table = ENTITY_TABLES[entityType]
  const cols = opts?.snapshotCols ?? '*'

  const { rows: before } = await op.tx.query<Snapshot>(
    `SELECT ${cols} FROM ${table} WHERE ${where.sql} FOR UPDATE`,
    where.params ?? [],
  )
  if (before.length === 0) return { before: [], after: [] }

  const setParams = set.params ?? []
  const ids = before.map((r: Snapshot) => r.id)
  const { rows: after } = await op.tx.query<Snapshot>(
    `UPDATE ${table} SET ${set.sql} WHERE id = ANY($${setParams.length + 1}::uuid[]) RETURNING ${cols}`,
    [...setParams, ids],
  )

  const afterById = new Map<string, Snapshot>(after.map((r: Snapshot) => [String(r.id), r] as [string, Snapshot]))
  for (const b of before) {
    await writeAudit(op, {
      entityType,
      entityId: String(b.id),
      before: b,
      after: afterById.get(String(b.id)) ?? null,
      action: opts?.action,
      ...(opts?.familyId !== undefined ? { familyId: opts.familyId } : {}),
    })
  }
  return { before, after }
}

/** Audited hard delete: DELETE … RETURNING * → one audit row per deleted row. */
export async function captureAndDelete(
  op: OperationContext,
  entityType: Exclude<EntityType, 'operation'>,
  where: SqlFragment,
  opts?: { action?: string; familyId?: string | null },
): Promise<Snapshot[]> {
  const table = ENTITY_TABLES[entityType]
  const { rows: deleted } = await op.tx.query<Snapshot>(
    `DELETE FROM ${table} WHERE ${where.sql} RETURNING *`,
    where.params ?? [],
  )
  for (const row of deleted) {
    await writeAudit(op, {
      entityType,
      entityId: entityIdOf(entityType, row),
      before: row,
      after: null,
      action: opts?.action,
      ...(opts?.familyId !== undefined ? { familyId: opts.familyId } : {}),
    })
  }
  return deleted
}
