// Thin SQL surface for the `family_members` join table.
//
// Reads accept an optional QueryRunner; the insert requires an
// OperationContext so membership changes are always audited.

import { defaultRunner, type QueryRunner } from '../utils/db'
import { auditCreate, type OperationContext, type Snapshot } from '../utils/audit'

/** True when (familyId, userId) is already a member. */
export async function exists(
  familyId: string,
  userId: string,
  runner: QueryRunner = defaultRunner,
): Promise<boolean> {
  const { rowCount } = await runner.query(
    `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
    [familyId, userId],
  )
  return (rowCount ?? 0) > 0
}

export async function insert(
  familyId: string,
  userId: string,
  role: 'admin' | 'member' = 'member',
  op: OperationContext,
): Promise<void> {
  const { rows: [row] } = await op.tx.query<Snapshot>(
    `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, $3) RETURNING *`,
    [familyId, userId, role],
  )
  if (row) await auditCreate(op, 'family_member', row, { familyId })
}
