// Thin SQL surface for the `persons` table.
//
// Reads accept an optional QueryRunner so the same call works both inside and
// outside a withTransaction() callback. Mutations require an OperationContext
// — every write is audited and stamped with the operation_id.

import { defaultRunner, type QueryRunner } from '../utils/db'
import { captureAndUpdate, type OperationContext } from '../utils/audit'

export interface PersonRow {
  id:                string
  primary_family_id: string
  full_name:         string
  node_state:        'proxy' | 'invited' | 'claimed'
  claimed_by:        string | null
  is_alive:          boolean
  invite_token:      string | null
  // …other columns exist on the table but callers that need them should
  // narrow via their own row type. Keeping this interface tight prevents
  // every repo consumer from coupling to the full schema.
}

/** Fetch a person by id within a family. Returns null when not found. */
export async function findByIdInFamily<T = PersonRow>(
  id: string,
  familyId: string,
  runner: QueryRunner = defaultRunner,
): Promise<T | null> {
  const { rows: [row] } = await runner.query<Record<string, unknown>>(
    `SELECT * FROM persons
     WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId],
  )
  return (row as T | undefined) ?? null
}

/** Soft-delete a person by id. */
export async function softDelete(
  id: string,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'person', {
    sql: 'id = $1 AND deleted_at IS NULL',
    params: [id],
  }, {
    sql: 'deleted_at = NOW()',
  })
}

/** Mark a node `claimed` and attach a user as the owner. Used by invite-claim and signup-via-invite. */
export async function markClaimed(
  personId: string,
  userId: string,
  op: OperationContext,
): Promise<void> {
  await captureAndUpdate(op, 'person', {
    sql: 'id = $1',
    params: [personId],
  }, {
    sql: `node_state = 'claimed', claimed_by = $1, invite_token = NULL, updated_at = NOW()`,
    params: [userId],
  })
}
