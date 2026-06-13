// Thin SQL surface for the `relationships` table.
//
// Reads accept an optional QueryRunner so the same call works both inside and
// outside a withTransaction() callback. Mutations require an OperationContext
// — every write is audited and stamped with the operation_id, so an
// un-audited relationship write cannot compile.

import { defaultRunner, type QueryRunner } from '../utils/db'
import { captureAndUpdate, type OperationContext } from '../utils/audit'

type RelType = 'PARENT_OF' | 'SPOUSE_OF' | 'SIBLING_OF'

const SOFT_DELETE = { sql: 'deleted_at = NOW()' }

/** Soft-delete every active edge that touches `personId`, in either direction. */
export async function softDeleteAllForPerson(
  personId: string,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'relationship', {
    sql: '(from_person_id = $1 OR to_person_id = $1) AND deleted_at IS NULL',
    params: [personId],
  }, SOFT_DELETE)
}

/** Soft-delete active edges of a given relType touching `personId`. */
export async function softDeleteForPersonByType(
  personId: string,
  relType: RelType,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'relationship', {
    sql: '(from_person_id = $1 OR to_person_id = $1) AND rel_type = $2 AND deleted_at IS NULL',
    params: [personId, relType],
  }, SOFT_DELETE)
}

/** Same as above but limited to inbound edges (e.g. PARENT_OF pointing AT this person). */
export async function softDeleteInboundByType(
  personId: string,
  relType: RelType,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'relationship', {
    sql: 'to_person_id = $1 AND rel_type = $2 AND deleted_at IS NULL',
    params: [personId, relType],
  }, SOFT_DELETE)
}

/** Same as above but limited to outbound edges (e.g. PARENT_OF from this person to children). */
export async function softDeleteOutboundByType(
  personId: string,
  relType: RelType,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'relationship', {
    sql: 'from_person_id = $1 AND rel_type = $2 AND deleted_at IS NULL',
    params: [personId, relType],
  }, SOFT_DELETE)
}

/** Count active PARENT_OF edges going OUT from `personId` (i.e. their children). */
export async function countActiveChildrenOf(
  personId: string,
  runner: QueryRunner = defaultRunner,
): Promise<number> {
  const { rows: [{ n }] } = await runner.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM relationships
     WHERE from_person_id = $1 AND rel_type = 'PARENT_OF' AND deleted_at IS NULL`,
    [personId],
  )
  return parseInt(n, 10) || 0
}

/** Count active edges touching `personId`. Used to decide soft- vs hard-delete. */
export async function countActiveForPerson(
  personId: string,
  runner: QueryRunner = defaultRunner,
): Promise<number> {
  const { rows: [{ remaining }] } = await runner.query<{ remaining: string }>(
    `SELECT COUNT(*)::text AS remaining FROM relationships
     WHERE (from_person_id = $1 OR to_person_id = $1) AND deleted_at IS NULL`,
    [personId],
  )
  return parseInt(remaining, 10) || 0
}

/** Soft-delete a single edge by id. */
export async function softDeleteById(
  id: string,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'relationship', {
    sql: 'id = $1 AND deleted_at IS NULL',
    params: [id],
  }, SOFT_DELETE)
}
