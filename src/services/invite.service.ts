import { query } from '../utils/db'
import { withOperation } from '../utils/audit'
import { logger } from '../utils/logger'
import { notFound, conflict, unauthorized } from '../utils/errors'
import * as personsRepo from '../repositories/persons.repo'
import * as familyMembersRepo from '../repositories/familyMembers.repo'

export async function claimByToken(token: string, userId: string) {
  // The JWT can outlive the user row it references (e.g. after a database
  // reset/restore), leaving a syntactically valid token whose userId no longer
  // exists. Claiming would then violate persons.claimed_by_fkey and surface as a
  // confusing 500. Fail fast with a clean 401 so the client re-authenticates.
  const { rows: [actor] } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1`,
    [userId],
  )
  if (!actor) {
    logger.warn({ userId }, 'claimByToken: token references a missing user')
    throw unauthorized('Your session is no longer valid — please sign in again')
  }

  const { rows: [person] } = await query<{
    id: string; full_name: string; node_state: string
    claimed_by: string | null; primary_family_id: string; is_alive: boolean
    community_id: string | null
  }>(
    `SELECT id, full_name, node_state, claimed_by, primary_family_id, is_alive, community_id
     FROM persons
     WHERE invite_token = $1 AND deleted_at IS NULL
       AND invite_sent_at > NOW() - INTERVAL '5 minutes'`,
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

  await withOperation(
    { action: 'person.claim', actorId: userId, familyId: person.primary_family_id },
    async op => {
      await personsRepo.markClaimed(person.id, userId, op)
      if (!alreadyMember) {
        await familyMembersRepo.insert(person.primary_family_id, userId, 'member', op)
      }
      // The claimed node lives in a community family — make the claimer a full
      // community member too, so they get community scope (search/visibility),
      // not just family membership. Idempotent on the (community_id, user_id) PK.
      if (person.community_id) {
        await op.tx.query(
          `INSERT INTO community_members (community_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (community_id, user_id) DO NOTHING`,
          [person.community_id, userId],
        )
      }
    },
  )

  logger.info({ personId: person.id, userId, familyId: person.primary_family_id, communityId: person.community_id }, 'invite claimed')
  return {
    success: true,
    person_id: person.id,
    family_id: person.primary_family_id,
    community_id: person.community_id,
    full_name: person.full_name,
  }
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
     WHERE p.invite_token = $1 AND p.deleted_at IS NULL
       AND p.invite_sent_at > NOW() - INTERVAL '5 minutes'`,
    [token.toUpperCase()]
  )

  if (!person) throw notFound('Invalid or expired invite code')
  if (person.node_state === 'claimed') throw conflict('This node has already been claimed')

  return person
}
