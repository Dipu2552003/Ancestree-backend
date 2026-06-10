// Thin SQL surface for the `family_members` join table.

import { defaultRunner, type QueryRunner } from '../utils/db'

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
  role: 'owner' | 'member' = 'member',
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, $3)`,
    [familyId, userId, role],
  )
}
