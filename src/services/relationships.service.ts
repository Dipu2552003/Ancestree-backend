import { query } from '../utils/db'
import { CreateRelationshipInput } from '../schemas/relationship.schema'

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
  if (persons.length < 2) throw { status: 404, message: 'One or both persons not found in your family' }

  const { rowCount: dup } = await query(
    `SELECT id FROM relationships
     WHERE ((from_person_id = $1 AND to_person_id = $2) OR (from_person_id = $2 AND to_person_id = $1))
       AND rel_type = $3 AND deleted_at IS NULL`,
    [input.from_person_id, input.to_person_id, input.rel_type]
  )
  if (dup && dup > 0) throw { status: 409, message: 'This relationship already exists' }

  if (input.rel_type === 'PARENT_OF') {
    const cycle = await hasCycle(input.from_person_id, input.to_person_id)
    if (cycle) throw { status: 400, message: 'This relationship would create a cycle' }
  }

  const { rows: [rel] } = await query(
    `INSERT INTO relationships
       (primary_family_id, from_person_id, to_person_id, rel_type, sub_type, union_year, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      familyId,
      input.from_person_id,
      input.to_person_id,
      input.rel_type,
      input.sub_type ?? null,
      input.union_year ?? null,
      userId,
    ]
  )

  if (input.rel_type === 'SPOUSE_OF') {
    await linkSpouseToChildren(input.from_person_id, input.to_person_id, familyId, userId)
    await linkSpouseToChildren(input.to_person_id, input.from_person_id, familyId, userId)
  }

  return rel
}

// For each child that existingParentId already parents, create a PARENT_OF
// edge from newParentId to that child — but only when no such edge exists yet.
async function linkSpouseToChildren(
  newParentId: string,
  existingParentId: string,
  familyId: string,
  createdBy: string,
): Promise<void> {
  await query(
    `INSERT INTO relationships (primary_family_id, from_person_id, to_person_id, rel_type, created_by)
     SELECT $1, $2, r.to_person_id, 'PARENT_OF', $3
     FROM relationships r
     WHERE r.from_person_id = $4
       AND r.rel_type = 'PARENT_OF'
       AND r.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM relationships x
         WHERE x.from_person_id = $2
           AND x.to_person_id   = r.to_person_id
           AND x.rel_type       = 'PARENT_OF'
           AND x.deleted_at IS NULL
       )`,
    [familyId, newParentId, createdBy, existingParentId],
  )
}

export async function getRelationshipById(id: string, familyId: string) {
  const { rows: [rel] } = await query(
    `SELECT * FROM relationships
     WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId]
  )
  if (!rel) throw { status: 404, message: 'Relationship not found' }
  return rel
}

export async function deleteRelationship(id: string, familyId: string) {
  await getRelationshipById(id, familyId)
  await query(`UPDATE relationships SET deleted_at = NOW() WHERE id = $1`, [id])
  return { success: true }
}
