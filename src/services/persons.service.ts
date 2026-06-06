import crypto from 'crypto'
import pool, { query } from '../utils/db'
import { CreatePersonInput, UpdatePersonInput } from '../schemas/person.schema'
import { searchDuplicates } from './merge.service'
import { createPossibleMatchNotification } from './notification.service'
import { logger } from '../utils/logger'

async function nextPersonCode(familyId: string): Promise<string> {
  const { rows: [fam] } = await query<{ name_prefix: string; person_code_seq: number }>(
    `UPDATE families
     SET person_code_seq = person_code_seq + 1
     WHERE id = $1
     RETURNING name_prefix, person_code_seq`,
    [familyId]
  )
  const seq = String(fam.person_code_seq).padStart(3, '0')
  return `${fam.name_prefix}-${seq}`
}

export async function createPerson(
  input: CreatePersonInput,
  userId: string,
  familyId: string
) {
  const personCode = await nextPersonCode(familyId)

  const { rows: [person] } = await query(
    `INSERT INTO persons (
       person_code, primary_family_id, full_name, first_name, last_name,
       name_native, nickname, gender, birth_year, birth_place,
       death_year, is_alive, bio, occupation, photo_url, visibility,
       current_city, current_state, current_country, native_village, gotra, education,
       node_state, created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       'proxy',$23
     ) RETURNING *`,
    [
      personCode, familyId, input.full_name, input.first_name ?? null, input.last_name ?? null,
      input.name_native ?? null, input.nickname ?? null, input.gender ?? null,
      input.birth_year ?? null, input.birth_place ?? null, input.death_year ?? null,
      input.is_alive ?? true, input.bio ?? null, input.occupation ?? null,
      input.photo_url ?? null, input.visibility ?? 'family',
      input.current_city ?? null, input.current_state ?? null, input.current_country ?? null,
      input.native_village ?? null, input.gotra ?? null, input.education ?? null,
      userId,
    ]
  )

  logger.info({ personId: person.id, personCode, familyId, name: input.full_name }, 'person created')

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

  return { ...person, potential_matches }
}

export async function getPersonById(id: string, familyId: string) {
  const { rows: [person] } = await query(
    `SELECT * FROM persons WHERE id = $1 AND primary_family_id = $2 AND deleted_at IS NULL`,
    [id, familyId]
  )
  if (!person) throw { status: 404, message: 'Person not found' }
  return person
}

export async function updatePerson(
  id: string,
  input: UpdatePersonInput,
  userId: string,
  familyId: string
) {
  const person = await getPersonById(id, familyId)

  if (person.node_state === 'claimed' && person.claimed_by !== userId) {
    logger.warn({ personId: id, userId, claimedBy: person.claimed_by }, 'updatePerson: forbidden')
    throw { status: 403, message: 'Only the profile owner can edit a claimed profile' }
  }

  const allowed = [
    'full_name', 'first_name', 'last_name', 'name_native', 'nickname', 'gender',
    'birth_year', 'birth_place', 'death_year', 'is_alive', 'bio', 'occupation',
    'photo_url', 'visibility',
    'current_city', 'current_state', 'current_country',
    'native_village', 'gotra', 'education',
  ]

  const fields = Object.entries(input).filter(
    ([k, v]) => allowed.includes(k) && v !== undefined
  )
  if (fields.length === 0) throw { status: 400, message: 'No valid fields to update' }

  const setClauses = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ')
  const values = fields.map(([, v]) => v)

  const { rows: [updated] } = await query(
    `UPDATE persons SET ${setClauses}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  )

  // When the user explicitly sets a real name, check whether that person
  // already exists in another family's tree and return the matches so the
  // frontend can offer a merge request immediately.
  let potential_matches: import('./merge.service').PotentialMatch[] = []
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

  if (person.node_state !== 'proxy') {
    throw { status: 400, message: 'Only proxy nodes can be invited' }
  }
  if (!person.is_alive) {
    throw { status: 400, message: 'Cannot invite a deceased person' }
  }

  const token = crypto.randomBytes(4).toString('hex').toUpperCase()

  await query(
    `UPDATE persons SET invite_token = $1, node_state = 'invited', invite_sent_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [token, id]
  )

  logger.info({ personId: id, userId, familyId }, 'invite token generated')
  return { invite_token: token }
}

export async function deletePerson(id: string, userId: string, familyId: string) {
  const person = await getPersonById(id, familyId)

  if (person.claimed_by === userId) {
    logger.warn({ personId: id, userId }, 'deletePerson: tried to delete own node')
    throw { status: 403, message: 'You cannot delete your own node' }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Remove edges that attach this person to their parents' family unit:
    // 1. PARENT_OF edges pointing TO this person (Keshav→Ishu, Shilpa→Ishu)
    await client.query(
      `UPDATE relationships SET deleted_at = NOW()
       WHERE to_person_id = $1 AND rel_type = 'PARENT_OF' AND deleted_at IS NULL`,
      [id],
    )

    // 2. SIBLING_OF edges (derived from the shared-parent relationship)
    await client.query(
      `UPDATE relationships SET deleted_at = NOW()
       WHERE (from_person_id = $1 OR to_person_id = $1)
         AND rel_type = 'SIBLING_OF' AND deleted_at IS NULL`,
      [id],
    )

    // 3. SPOUSE_OF edges
    await client.query(
      `UPDATE relationships SET deleted_at = NOW()
       WHERE (from_person_id = $1 OR to_person_id = $1)
         AND rel_type = 'SPOUSE_OF' AND deleted_at IS NULL`,
      [id],
    )

    // 4. PARENT_OF edges FROM this person (this person → their children)
    await client.query(
      `UPDATE relationships SET deleted_at = NOW()
       WHERE from_person_id = $1 AND rel_type = 'PARENT_OF' AND deleted_at IS NULL`,
      [id],
    )

    // Check whether any edges remain (anything unexpected)
    const { rows: [{ remaining }] } = await client.query<{ remaining: string }>(
      `SELECT COUNT(*) AS remaining FROM relationships
       WHERE (from_person_id = $1 OR to_person_id = $1) AND deleted_at IS NULL`,
      [id],
    )
    const hasOwnFamily = parseInt(remaining) > 0

    // Only hard-delete the node if it is unclaimed AND has no remaining connections.
    // Claimed nodes are never deleted — the account owner still exists.
    // Proxy/invited nodes with a spouse or children stay as their own family unit.
    const softDeleted = !hasOwnFamily && person.node_state !== 'claimed'
    if (softDeleted) {
      await client.query(`UPDATE persons SET deleted_at = NOW() WHERE id = $1`, [id])
    } else if (!softDeleted) {
      logger.warn({ personId: id, userId, hasOwnFamily, nodeState: person.node_state }, 'person node kept — relationships removed only')
    }

    await client.query('COMMIT')
    logger.info({ personId: id, userId, softDeleted }, 'person deleted')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return { success: true }
}
