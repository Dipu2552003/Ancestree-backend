// Thin SQL surface for the `relationships` table.
//
// Every function accepts an optional QueryRunner so the same call works both
// inside and outside a withTransaction() callback.

import { defaultRunner, type QueryRunner } from '../utils/db'

type RelType = 'PARENT_OF' | 'SPOUSE_OF' | 'SIBLING_OF'

/** Soft-delete every active edge that touches `personId`, in either direction. */
export async function softDeleteAllForPerson(
  personId: string,
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `UPDATE relationships SET deleted_at = NOW()
     WHERE (from_person_id = $1 OR to_person_id = $1)
       AND deleted_at IS NULL`,
    [personId],
  )
}

/** Soft-delete active edges of a given relType touching `personId`. */
export async function softDeleteForPersonByType(
  personId: string,
  relType: RelType,
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `UPDATE relationships SET deleted_at = NOW()
     WHERE (from_person_id = $1 OR to_person_id = $1)
       AND rel_type = $2 AND deleted_at IS NULL`,
    [personId, relType],
  )
}

/** Same as above but limited to inbound edges (e.g. PARENT_OF pointing AT this person). */
export async function softDeleteInboundByType(
  personId: string,
  relType: RelType,
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `UPDATE relationships SET deleted_at = NOW()
     WHERE to_person_id = $1 AND rel_type = $2 AND deleted_at IS NULL`,
    [personId, relType],
  )
}

/** Same as above but limited to outbound edges (e.g. PARENT_OF from this person to children). */
export async function softDeleteOutboundByType(
  personId: string,
  relType: RelType,
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `UPDATE relationships SET deleted_at = NOW()
     WHERE from_person_id = $1 AND rel_type = $2 AND deleted_at IS NULL`,
    [personId, relType],
  )
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
  runner: QueryRunner = defaultRunner,
): Promise<void> {
  await runner.query(
    `UPDATE relationships SET deleted_at = NOW() WHERE id = $1`,
    [id],
  )
}
