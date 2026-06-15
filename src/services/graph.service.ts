import { query } from '../utils/db'
import { logger } from '../utils/logger'
import { notFound } from '../utils/errors'

// A syntactically valid UUID that matches no real user/family. Passed as the
// "viewer" identity for the public, unauthenticated tree view so every node is
// resolved as read-only (no membership, nothing claimed by the viewer) without
// breaking the uuid-typed family_members lookup inside fetchFamilyGraph().
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

// Node-data fields stripped from every node before the graph is served to an
// unauthenticated visitor — contact details and precise dates/address are never
// exposed publicly. Names, photos, places, and relationships stay visible.
const PUBLIC_REDACTED_FIELDS = [
  'phone', 'whatsapp', 'email',
  'currentAddress', 'currentPincode',
  'birthDate', 'deathDate',
] as const

// An invite that is never claimed shouldn't pin a node in the 'invited' state
// forever. After this many days the node reverts to 'proxy' (its token cleared)
// so it can be re-invited cleanly. Expiry is applied lazily whenever the family
// graph is fetched — see expireStaleInvites().
const INVITE_EXPIRY_DAYS = 7

/**
 * Revert any of this family's invites that have gone stale: 'invited' nodes
 * whose invite is older than INVITE_EXPIRY_DAYS and were never claimed go back
 * to 'proxy' with their token cleared. This is a system maintenance transition
 * (not a user action), so it is intentionally NOT audited.
 */
async function expireStaleInvites(familyId: string): Promise<void> {
  const { rowCount } = await query(
    `UPDATE persons
     SET    node_state = 'proxy', invite_token = NULL, updated_at = NOW()
     WHERE  primary_family_id = $1
       AND  node_state        = 'invited'
       AND  invite_sent_at IS NOT NULL
       AND  invite_sent_at  < NOW() - make_interval(days => $2)`,
    [familyId, INVITE_EXPIRY_DAYS],
  )
  if (rowCount && rowCount > 0) {
    logger.info({ familyId, expired: rowCount }, 'reverted stale invites to proxy')
  }
}


interface DBPerson {
  id: string; full_name: string; first_name: string | null; middle_name: string | null; last_name: string | null
  nickname: string | null; gender: string | null
  gotra: string | null; religion: string | null
  birth_date: string | null; birth_year: number | null; birth_place: string | null
  death_date: string | null; death_year: number | null; death_place: string | null; is_alive: boolean
  phone: string | null; whatsapp: string | null; email: string | null
  current_address: string | null; current_city: string | null; current_state: string | null
  current_country: string | null; current_pincode: string | null
  native_village: string | null; native_tehsil: string | null; native_district: string | null
  native_state: string | null; native_country: string | null
  occupation: string | null; occupation_detail: string | null; education: string | null; bio: string | null
  photo_url: string | null; photo_thumbnail_url: string | null; node_state: string; claimed_by: string | null
  created_by: string; visibility: string; person_code: string; primary_family_id: string
}

interface DBRelationship {
  id: string; from_person_id: string; to_person_id: string
  rel_type: string; sub_type: string | null; is_active: boolean
}


function deriveLabel(
  relation: 'parent' | 'child' | 'spouse' | 'sibling',
  fromLabel: string,
  gender: string | null
): string {
  const isFemale = gender === 'female'

  if (fromLabel === 'You') {
    if (relation === 'parent')  return isFemale ? 'Mother' : 'Father'
    if (relation === 'child')   return isFemale ? 'Daughter' : 'Son'
    if (relation === 'spouse')  return isFemale ? 'Wife' : 'Husband'
    if (relation === 'sibling') return isFemale ? 'Sister' : 'Brother'
  }
  if (fromLabel === 'Father' || fromLabel === 'Mother') {
    if (relation === 'parent')  return isFemale ? 'Grandmother' : 'Grandfather'
    if (relation === 'spouse')  return fromLabel === 'Father' ? 'Mother' : 'Father'
    if (relation === 'sibling') return isFemale ? 'Aunt' : 'Uncle'
    if (relation === 'child')   return isFemale ? 'Sister' : 'Brother'
  }
  if (fromLabel === 'Grandfather' || fromLabel === 'Grandmother') {
    if (relation === 'parent')  return isFemale ? 'Great-Grandmother' : 'Great-Grandfather'
    if (relation === 'spouse')  return fromLabel === 'Grandfather' ? 'Grandmother' : 'Grandfather'
    if (relation === 'child')   return isFemale ? 'Aunt' : 'Uncle'
  }
  if (fromLabel === 'Son' || fromLabel === 'Daughter') {
    if (relation === 'child')   return isFemale ? 'Granddaughter' : 'Grandson'
    if (relation === 'spouse')  return fromLabel === 'Son' ? 'Daughter-in-Law' : 'Son-in-Law'
  }
  return 'Relative'
}

function computeRelToSelf(
  selfId: string,
  persons: DBPerson[],
  rels: DBRelationship[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const visited = new Set<string>()
  const personMap = new Map(persons.map(p => [p.id, p]))

  type QItem = { personId: string; label: string }
  const queue: QItem[] = [{ personId: selfId, label: 'You' }]
  visited.add(selfId)
  labels.set(selfId, 'You')

  while (queue.length > 0) {
    const { personId, label } = queue.shift()!

    const process = (id: string, relation: 'parent' | 'child' | 'spouse' | 'sibling') => {
      if (visited.has(id)) return
      visited.add(id)
      const p = personMap.get(id)
      const newLabel = deriveLabel(relation, label, p?.gender ?? null)
      labels.set(id, newLabel)
      queue.push({ personId: id, label: newLabel })
    }

    rels.filter(r => r.rel_type === 'PARENT_OF' && r.to_person_id === personId)
      .forEach(r => process(r.from_person_id, 'parent'))

    rels.filter(r => r.rel_type === 'PARENT_OF' && r.from_person_id === personId)
      .forEach(r => process(r.to_person_id, 'child'))

    rels.filter(r => r.rel_type === 'SPOUSE_OF' &&
      (r.from_person_id === personId || r.to_person_id === personId))
      .forEach(r => process(
        r.from_person_id === personId ? r.to_person_id : r.from_person_id, 'spouse'
      ))

    rels.filter(r => r.rel_type === 'SIBLING_OF' &&
      (r.from_person_id === personId || r.to_person_id === personId))
      .forEach(r => process(
        r.from_person_id === personId ? r.to_person_id : r.from_person_id, 'sibling'
      ))
  }

  return labels
}

/**
 * Compute generation offset from perspective for every reachable person, via
 * unbounded BFS over PARENT_OF / SPOUSE_OF / SIBLING_OF edges.
 *
 *   parent of N   → gen N-1
 *   child of N    → gen N+1
 *   spouse of N   → gen N
 *   sibling of N  → gen N
 *
 * Edges that hit unknown persons are skipped.  Disconnected components are
 * absent from the result (filtered out before reaching the client).
 */
function computeGenerations(
  perspectiveId: string,
  rels: DBRelationship[],
): Map<string, number> {
  const childrenOf = new Map<string, string[]>()
  const parentsOf  = new Map<string, string[]>()
  const spousesOf  = new Map<string, string[]>()
  const siblingsOf = new Map<string, string[]>()

  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k); if (a) a.push(v); else m.set(k, [v])
  }

  for (const r of rels) {
    if (r.rel_type === 'PARENT_OF') {
      push(childrenOf, r.from_person_id, r.to_person_id)
      push(parentsOf,  r.to_person_id,   r.from_person_id)
    } else if (r.rel_type === 'SPOUSE_OF') {
      push(spousesOf, r.from_person_id, r.to_person_id)
      push(spousesOf, r.to_person_id,   r.from_person_id)
    } else if (r.rel_type === 'SIBLING_OF') {
      push(siblingsOf, r.from_person_id, r.to_person_id)
      push(siblingsOf, r.to_person_id,   r.from_person_id)
    }
  }

  const gen = new Map<string, number>([[perspectiveId, 0]])
  const queue: string[] = [perspectiveId]

  while (queue.length > 0) {
    const id = queue.shift()!
    const g  = gen.get(id)!

    const visit = (next: string, nextGen: number) => {
      if (gen.has(next)) return
      gen.set(next, nextGen)
      queue.push(next)
    }

    for (const p of parentsOf.get(id)  ?? []) visit(p, g - 1)
    for (const c of childrenOf.get(id) ?? []) visit(c, g + 1)
    for (const s of spousesOf.get(id)  ?? []) visit(s, g)
    for (const s of siblingsOf.get(id) ?? []) visit(s, g)
  }

  return gen
}

export async function fetchFamilyGraph(
  familyId: string,
  userId: string,
  userFamilyId: string,
  perspectivePersonId?: string,
  ancestorDepth: number = 10,
  descendantDepth: number = 10,
) {
  // Lazily revert any of this family's expired invites before reading the graph,
  // so the returned node_state / canInvite reflect the reverted 'proxy' status.
  await expireStaleInvites(familyId)

  const [{ rows: persons }, { rows: rels }, { rows: [membership] }] = await Promise.all([
    query<DBPerson>(
      // Fetch this family's own persons PLUS any cross-family persons that are
      // directly referenced by this family's relationship rows.  This makes
      // merged canonical nodes (whose primary_family_id belongs to another
      // family) visible in the graph after a merge.
      `SELECT DISTINCT
              p.id, p.person_code, p.primary_family_id, p.node_state, p.claimed_by, p.created_by, p.visibility,
              p.full_name, p.first_name, p.middle_name, p.last_name, p.nickname,
              p.gender, p.gotra, p.religion,
              p.birth_date, p.birth_year, p.birth_place,
              p.is_alive, p.death_date, p.death_year, p.death_place,
              p.phone, p.whatsapp, p.email,
              p.current_address, p.current_city, p.current_state, p.current_country, p.current_pincode,
              p.native_village, p.native_tehsil, p.native_district, p.native_state, p.native_country,
              p.occupation, p.occupation_detail, p.education, p.bio,
              p.photo_url, p.photo_thumbnail_url
       FROM persons p
       WHERE p.deleted_at IS NULL
         AND (
           p.primary_family_id = $1
           OR p.id IN (
             SELECT from_person_id FROM relationships
             WHERE primary_family_id = $1 AND deleted_at IS NULL
             UNION
             SELECT to_person_id FROM relationships
             WHERE primary_family_id = $1 AND deleted_at IS NULL
           )
         )`,
      [familyId]
    ),
    query<DBRelationship>(
      `SELECT id, from_person_id, to_person_id, rel_type, sub_type, is_active
       FROM relationships
       WHERE primary_family_id = $1 AND deleted_at IS NULL`,
      [familyId]
    ),
    query<{ role: string }>(
      `SELECT role FROM family_members WHERE family_id = $1 AND user_id = $2`,
      [familyId, userId]
    ),
  ])

  const isAdmin = membership?.role === 'admin'

  let selfId: string | undefined
  if (perspectivePersonId && persons.some(p => p.id === perspectivePersonId)) {
    selfId = perspectivePersonId
  } else {
    selfId = persons.find(p => p.claimed_by === userId)?.id ?? persons[0]?.id
  }

  if (!selfId) {
    logger.warn({ familyId, userId }, 'fetchFamilyGraph: no persons found')
    return { nodes: [], edges: [], meta: { totalNodes: 0 } }
  }

  // ── Depth-bounded reachability from perspective ─────────────────────────
  // Compute generation offset for every person reachable from the perspective
  // (unbounded), then keep only those within [-ancestorDepth, +descendantDepth].
  // Anything outside is held back for the "Load more" expand action; anything
  // unreachable is dropped entirely (orphans never reach the client).
  const generations    = computeGenerations(selfId, rels)
  const ancestorClamp  = Math.max(0, ancestorDepth)
  const descendantClamp = Math.max(0, descendantDepth)

  let hasMoreAncestors   = false
  let hasMoreDescendants = false
  const inRange = new Set<string>()
  for (const [id, g] of generations) {
    if (g < -ancestorClamp) { hasMoreAncestors   = true; continue }
    if (g >  descendantClamp) { hasMoreDescendants = true; continue }
    inRange.add(id)
  }

  const visiblePersons = persons.filter(p => inRange.has(p.id))
  const visibleRels    = rels.filter(r => inRange.has(r.from_person_id) && inRange.has(r.to_person_id))

  const relToSelf = computeRelToSelf(selfId, visiblePersons, visibleRels)

  const nodes = visiblePersons.map(p => ({
    id: p.id,
    type: 'personNode',
    position: { x: 0, y: 0 },  // frontend computes actual positions
    data: {
      personId:           p.id,
      personCode:         p.person_code,
      fullName:           p.full_name,
      birthYear:          p.birth_year,
      deathYear:          p.death_year,
      isAlive:            p.is_alive,
      photoUrl:           p.photo_url,
      nodeState:          p.node_state,
      isSelf:             p.id === selfId,
      isViewerNode:       p.claimed_by === userId,
      isDeceased:         !p.is_alive,
      relationshipToSelf: relToSelf.get(p.id) ?? '',
      // Any family member can open the panel and add connections to any node.
      // Only the node's creator or claimer can edit the profile fields.
      // Cross-family canonical nodes (primary_family_id differs) are fully read-only.
      canEdit:            p.primary_family_id === userFamilyId,
      canEditProfile:     p.primary_family_id === userFamilyId && (p.node_state === 'claimed' ? p.claimed_by === userId : true),
      // Claimed nodes belong to a real user — no one can hard-delete them,
      // only disconnect (remove relationships). Proxy/invited nodes can be
      // deleted freely by any family member, except the viewer's own node.
      canDelete:          p.primary_family_id === userFamilyId && p.node_state !== 'claimed',
      canInvite:          p.primary_family_id === userFamilyId && (p.node_state === 'proxy' || p.node_state === 'invited') && p.is_alive,
      firstName:          p.first_name,
      middleName:         p.middle_name,
      lastName:           p.last_name,
      nickname:           p.nickname,
      gender:             p.gender,
      gotra:              p.gotra,
      religion:           p.religion,
      birthDate:          p.birth_date,
      birthPlace:         p.birth_place,
      deathDate:          p.death_date,
      deathPlace:         p.death_place,
      phone:              p.phone,
      whatsapp:           p.whatsapp,
      email:              p.email,
      currentAddress:     p.current_address,
      currentCity:        p.current_city,
      currentState:       p.current_state,
      currentCountry:     p.current_country,
      currentPincode:     p.current_pincode,
      nativeVillage:      p.native_village,
      nativeTehsil:       p.native_tehsil,
      nativeDistrict:     p.native_district,
      nativeState:        p.native_state,
      nativeCountry:      p.native_country,
      occupation:         p.occupation,
      occupationDetail:   p.occupation_detail,
      education:          p.education,
      bio:                p.bio,
      photoThumbnailUrl:  p.photo_thumbnail_url,
    },
  }))

  const edges = visibleRels.map(r => ({
    id: r.id,
    source: r.from_person_id,
    target: r.to_person_id,
    type: 'familyEdge',
    data: {
      relType:  r.rel_type,
      subType:  r.sub_type,
      isActive: r.is_active,
    },
  }))

  logger.debug({ familyId, userId, nodes: nodes.length, edges: edges.length, ancestorDepth: ancestorClamp, descendantDepth: descendantClamp, hasMoreAncestors, hasMoreDescendants }, 'graph fetched')
  return {
    nodes,
    edges,
    meta: {
      totalNodes:              nodes.length,
      perspectivePersonId:     selfId,
      effectiveAncestorDepth:   ancestorClamp,
      effectiveDescendantDepth: descendantClamp,
      hasMoreAncestors,
      hasMoreDescendants,
    },
  }
}

/**
 * Read-only family graph for the public landing-page viewer (no auth).
 *
 * Only persons in a PUBLIC, non-community family are viewable — private and
 * community trees throw notFound. Relationship labels are computed relative to
 * the focal (searched) person, and sensitive fields are stripped from every
 * node. The viewer identity is a nil UUID, so fetchFamilyGraph() resolves every
 * node as read-only (canEdit/canDelete/canInvite false, nothing claimed by the
 * viewer). Large depths are requested so the whole public tree is returned with
 * no "Load more" paging on the public page.
 */
export async function fetchPublicFamilyGraph(perspectivePersonId: string) {
  const { rows: [person] } = await query<{ visibility: string; community_id: string | null; primary_family_id: string }>(
    `SELECT p.primary_family_id, f.visibility, f.community_id
     FROM   persons p
     JOIN   families f ON f.id = p.primary_family_id AND f.deleted_at IS NULL
     WHERE  p.id = $1 AND p.deleted_at IS NULL`,
    [perspectivePersonId],
  )
  if (!person) throw notFound('Person not found')
  if (person.community_id || person.visibility !== 'public') {
    // Don't leak whether a private/community person exists — same error as missing.
    throw notFound('This profile is not public')
  }

  const graph = await fetchFamilyGraph(
    person.primary_family_id, NIL_UUID, NIL_UUID, perspectivePersonId, 100, 100,
  )

  const nodes = graph.nodes.map(n => {
    const data = { ...(n.data as Record<string, unknown>) }
    for (const f of PUBLIC_REDACTED_FIELDS) data[f] = null
    return { ...n, data }
  })

  logger.debug({ perspectivePersonId, nodes: nodes.length }, 'public graph fetched')
  return { ...graph, nodes }
}
