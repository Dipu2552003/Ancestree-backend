import { query } from '../utils/db'
import { withTransaction } from '../utils/transaction'
import { CreateRelationshipInput, UpdateRelationshipInput, ACTIVE_SPOUSE_SUBTYPES } from '../schemas/relationship.schema'
import { logger } from '../utils/logger'
import { badRequest, notFound, conflict } from '../utils/errors'
import * as relsRepo from '../repositories/relationships.repo'

function defaultSubType(rel_type: CreateRelationshipInput['rel_type']): string {
  if (rel_type === 'SPOUSE_OF')  return 'married'
  if (rel_type === 'SIBLING_OF') return 'full'
  return 'biological' // PARENT_OF
}

async function hasCycle(parentId: string, childId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `WITH RECURSIVE ancestors AS (
       SELECT from_person_id AS person_id
       FROM relationships
       WHERE to_person_id = $1 AND rel_type = 'PARENT_OF' AND deleted_at IS NULL
       UNION
       SELECT r.from_person_id
       FROM relationships r
       INNER JOIN ancestors a ON r.to_person_id = a.person_id
       WHERE r.rel_type = 'PARENT_OF' AND r.deleted_at IS NULL
     )
     SELECT EXISTS (SELECT 1 FROM ancestors WHERE person_id = $2) AS exists`,
    [parentId, childId]
  )
  return rows[0]?.exists ?? false
}

export async function createRelationship(
  input: CreateRelationshipInput,
  userId: string,
  familyId: string
) {
  const { rows: persons } = await query(
    `SELECT id FROM persons
     WHERE id = ANY($1::uuid[]) AND primary_family_id = $2 AND deleted_at IS NULL`,
    [[input.from_person_id, input.to_person_id], familyId]
  )
  if (persons.length < 2) {
    logger.warn({ from: input.from_person_id, to: input.to_person_id, familyId }, 'createRelationship: persons not found')
    throw notFound('One or both persons not found in your family')
  }

  const { rowCount: dup } = await query(
    `SELECT id FROM relationships
     WHERE ((from_person_id = $1 AND to_person_id = $2) OR (from_person_id = $2 AND to_person_id = $1))
       AND rel_type = $3 AND deleted_at IS NULL`,
    [input.from_person_id, input.to_person_id, input.rel_type]
  )
  if (dup && dup > 0) {
    logger.warn({ from: input.from_person_id, to: input.to_person_id, type: input.rel_type }, 'createRelationship: duplicate')
    throw conflict('This relationship already exists')
  }

  if (input.rel_type === 'PARENT_OF') {
    const cycle = await hasCycle(input.from_person_id, input.to_person_id)
    if (cycle) {
      logger.warn({ from: input.from_person_id, to: input.to_person_id }, 'createRelationship: cycle detected')
      throw badRequest('This relationship would create a cycle')
    }
  }

  const subType  = input.sub_type ?? defaultSubType(input.rel_type)
  const isActive = input.rel_type === 'SPOUSE_OF'
    ? ACTIVE_SPOUSE_SUBTYPES.has(subType as never)
    : true

  const { rows: [rel] } = await query(
    `INSERT INTO relationships
       (primary_family_id, from_person_id, to_person_id, rel_type, sub_type, union_year, separation_year, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      familyId,
      input.from_person_id,
      input.to_person_id,
      input.rel_type,
      subType,
      input.union_year      ?? null,
      input.separation_year ?? null,
      isActive,
      userId,
    ]
  )

  // NOTE: We do NOT auto-create PARENT_OF edges from the new spouse to the
  // anchor's existing children. PARENT_OF is the sole source of truth for
  // parentage and must be set explicitly by the caller. This lets the 2nd-wife
  // flow leave existing children attached to the 1st wife unless the user
  // re-assigns them through Flow E Phase 3 (the /reparent endpoint).

  if (input.rel_type === 'SIBLING_OF') {
    await linkSiblingGroup(input.from_person_id, input.to_person_id, familyId, userId)
  }

  logger.info({ relId: rel.id, from: input.from_person_id, to: input.to_person_id, type: input.rel_type, familyId }, 'relationship created')
  return rel
}

// When SIBLING_OF(A, B) is created, merge A's sibling group with B's sibling group.
// Every member of A's group must become a sibling of every member of B's group.
// Example: A already has siblings [X, Y], B has siblings [P]:
//   new pairs needed → A-P, X-B, X-P, Y-B, Y-P  (A-B was just inserted)
async function linkSiblingGroup(
  personA: string,
  personB: string,
  familyId: string,
  createdBy: string,
): Promise<void> {
  const sibsOf = async (id: string, exclude: string) => {
    const { rows } = await query<{ id: string }>(
      `SELECT CASE WHEN from_person_id = $1 THEN to_person_id ELSE from_person_id END AS id
       FROM   relationships
       WHERE  (from_person_id = $1 OR to_person_id = $1)
         AND  rel_type          = 'SIBLING_OF'
         AND  primary_family_id = $2
         AND  deleted_at        IS NULL
         AND  CASE WHEN from_person_id = $1 THEN to_person_id ELSE from_person_id END != $3`,
      [id, familyId, exclude],
    )
    return rows.map(r => r.id)
  }

  const groupA = [personA, ...(await sibsOf(personA, personB))]
  const groupB = [personB, ...(await sibsOf(personB, personA))]

  for (const x of groupA) {
    for (const y of groupB) {
      if (x === personA && y === personB) continue  // already inserted
      await query(
        `INSERT INTO relationships (primary_family_id, from_person_id, to_person_id, rel_type, created_by)
         SELECT $1, $2, $3, 'SIBLING_OF', $4
         WHERE NOT EXISTS (
           SELECT 1 FROM relationships
           WHERE  ((from_person_id = $2 AND to_person_id = $3)
                OR (from_person_id = $3 AND to_person_id = $2))
             AND  rel_type   = 'SIBLING_OF'
             AND  deleted_at IS NULL
         )`,
        [familyId, x, y, createdBy],
      )
    }
  }
}

export async function updateRelationship(
  id: string,
  input: UpdateRelationshipInput,
  familyId: string,
) {
  // Fetch the row first so we know the rel_type (sub_type semantics depend on it).
  const { rows: [existing] } = await query<{ rel_type: string; sub_type: string | null }>(
    `SELECT rel_type, sub_type FROM relationships
     WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId],
  )
  if (!existing) throw notFound('Relationship not found')

  const fields: string[] = []
  const values: unknown[] = []
  let i = 1

  if (input.sub_type !== undefined) {
    fields.push(`sub_type = $${i++}`)
    values.push(input.sub_type)

    // Keep is_active aligned with the status semantics for SPOUSE_OF.
    if (existing.rel_type === 'SPOUSE_OF') {
      fields.push(`is_active = $${i++}`)
      values.push(ACTIVE_SPOUSE_SUBTYPES.has(input.sub_type as never))
    }
  }
  if (input.union_year !== undefined) {
    fields.push(`union_year = $${i++}`)
    values.push(input.union_year)
  }
  if (input.separation_year !== undefined) {
    fields.push(`separation_year = $${i++}`)
    values.push(input.separation_year)
  }
  if (input.notes !== undefined) {
    fields.push(`notes = $${i++}`)
    values.push(input.notes)
  }
  if (fields.length === 0) {
    return { id, updated: false }
  }
  values.push(id, familyId)

  const { rows: [updated] } = await query(
    `UPDATE relationships SET ${fields.join(', ')}
     WHERE id = $${i++} AND primary_family_id = $${i} AND deleted_at IS NULL
     RETURNING *`,
    values,
  )
  if (!updated) throw notFound('Relationship not found')

  logger.info({ relId: id, fields: Object.keys(input), familyId }, 'relationship updated')
  return updated
}

/**
 * Atomic re-mother assignment used by Flow E Phase 3.
 * Each change drops the child's *current* mother PARENT_OF edge (if any) and
 * inserts a new one to `new_mother_id` (skipped when null = "Unknown").
 * The father edge is left untouched.
 */
export async function reparentChildren(
  fatherId: string,
  changes: { child_id: string; new_mother_id: string | null }[],
  userId: string,
  familyId: string,
): Promise<{ updated: number; skipped: number }> {
  const result = await withTransaction(async tx => {
    let updated = 0
    let skipped = 0

    for (const change of changes) {
      // Find the child's current mother(s) — i.e. PARENT_OF edges where
      // the source has gender='female' OR (lacking gender) is *not* the father.
      const { rows: currentMothers } = await tx.query<{ id: string; from_person_id: string }>(
        `SELECT r.id, r.from_person_id
         FROM   relationships r
         JOIN   persons p ON p.id = r.from_person_id
         WHERE  r.rel_type          = 'PARENT_OF'
           AND  r.to_person_id      = $1
           AND  r.primary_family_id = $2
           AND  r.deleted_at        IS NULL
           AND  r.from_person_id   != $3
           AND  (p.gender IS NULL OR p.gender = 'female')`,
        [change.child_id, familyId, fatherId],
      )

      // If nothing changes, skip.
      const currentMotherId = currentMothers[0]?.from_person_id ?? null
      if (currentMotherId === change.new_mother_id) { skipped++; continue }

      // Soft-delete old mother edges (audit trail preserved).
      for (const m of currentMothers) {
        await relsRepo.softDeleteById(m.id, tx)
      }

      // Insert new mother edge (skip when Unknown).
      if (change.new_mother_id) {
        await tx.query(
          `INSERT INTO relationships
             (primary_family_id, from_person_id, to_person_id, rel_type, sub_type, is_active, created_by)
           VALUES ($1, $2, $3, 'PARENT_OF', 'biological', TRUE, $4)
           ON CONFLICT DO NOTHING`,
          [familyId, change.new_mother_id, change.child_id, userId],
        )
      }
      updated++
    }

    return { updated, skipped }
  })

  logger.info({ fatherId, updated: result.updated, skipped: result.skipped, familyId }, 'reparentChildren')
  return result
}

export async function getRelationshipById(id: string, familyId: string) {
  const { rows: [rel] } = await query(
    `SELECT * FROM relationships
     WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId]
  )
  if (!rel) throw notFound('Relationship not found')
  return rel
}

export async function deleteRelationship(id: string, familyId: string) {
  await getRelationshipById(id, familyId)
  await query(`UPDATE relationships SET deleted_at = NOW() WHERE id = $1`, [id])
  logger.info({ relId: id, familyId }, 'relationship deleted')
  return { success: true }
}
