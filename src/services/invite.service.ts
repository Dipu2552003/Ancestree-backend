import { query } from '../utils/db'
import { withTransaction } from '../utils/transaction'
import { logger } from '../utils/logger'
import { notFound, conflict } from '../utils/errors'
import * as personsRepo from '../repositories/persons.repo'
import * as familyMembersRepo from '../repositories/familyMembers.repo'

export async function claimByToken(token: string, userId: string) {
  const { rows: [person] } = await query<{
    id: string; full_name: string; node_state: string
    claimed_by: string | null; primary_family_id: string; is_alive: boolean
  }>(
    `SELECT id, full_name, node_state, claimed_by, primary_family_id, is_alive
     FROM persons WHERE invite_token = $1 AND deleted_at IS NULL`,
    [token.toUpperCase()]
  )

  if (!person) {
    logger.warn({ token }, 'claimByToken: invalid token')
    throw notFound('Invalid or expired invite code')
  }
  if (person.node_state === 'claimed') {
    logger.warn({ personId: person.id, userId }, 'claimByToken: already claimed')
    throw conflict('This node has already been claimed')
  }
  if (person.claimed_by === userId) throw conflict('You already own this node')

  const alreadyMember = await familyMembersRepo.exists(person.primary_family_id, userId)

  await withTransaction(async tx => {
    await personsRepo.markClaimed(person.id, userId, tx)
    if (!alreadyMember) {
      await familyMembersRepo.insert(person.primary_family_id, userId, 'member', tx)
    }
  })

  logger.info({ personId: person.id, userId, familyId: person.primary_family_id }, 'invite claimed')
  return { success: true, person_id: person.id, family_id: person.primary_family_id, full_name: person.full_name }
}

export async function lookupToken(token: string) {
  // Inviter = the user who originally created the proxy node (persons.created_by).
  // We hop through users.person_id to surface their own node's full_name +
  // father/village/city, so the invitee sees a real person to recognise rather
  // than an opaque family-name string.
  const { rows: [person] } = await query<{
    full_name:               string
    node_state:              string
    primary_family_id:       string
    birth_year:              number | null
    photo_url:               string | null
    family_name:             string
    inviter_full_name:       string | null
    inviter_native_village:  string | null
    inviter_current_city:    string | null
    inviter_father_name:     string | null
  }>(
    `SELECT p.full_name, p.node_state, p.primary_family_id, p.birth_year, p.photo_url,
            f.name AS family_name,
            inv.full_name      AS inviter_full_name,
            inv.native_village AS inviter_native_village,
            inv.current_city   AS inviter_current_city,
            inv_father.full_name AS inviter_father_name
     FROM persons p
     JOIN families f ON f.id = p.primary_family_id
     LEFT JOIN users   u   ON u.id = p.created_by
     LEFT JOIN persons inv ON inv.id = u.person_id AND inv.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT fp.full_name
       FROM   relationships fr
       JOIN   persons fp ON fp.id = fr.from_person_id AND fp.deleted_at IS NULL
       WHERE  fr.to_person_id = inv.id
         AND  fr.rel_type     = 'PARENT_OF'
         AND  fr.deleted_at IS NULL
       ORDER BY (fp.gender = 'male') DESC NULLS LAST, fp.person_code
       LIMIT 1
     ) inv_father ON true
     WHERE p.invite_token = $1 AND p.deleted_at IS NULL`,
    [token.toUpperCase()]
  )

  if (!person) throw notFound('Invalid or expired invite code')
  if (person.node_state === 'claimed') throw conflict('This node has already been claimed')

  return person
}
