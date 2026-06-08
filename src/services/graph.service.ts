import { query } from '../utils/db'
import { logger } from '../utils/logger'


interface DBPerson {
  id: string; full_name: string; first_name: string | null; middle_name: string | null; last_name: string | null
  name_native: string | null; nickname: string | null; gender: string | null
  gotra: string | null; religion: string | null
  birth_date: string | null; birth_year: number | null; birth_place: string | null
  death_date: string | null; death_year: number | null; death_place: string | null; is_alive: boolean
  phone: string | null; whatsapp: string | null; email: string | null
  current_address: string | null; current_city: string | null; current_state: string | null
  current_country: string | null; current_pincode: string | null
  native_village: string | null; native_tehsil: string | null; native_district: string | null
  native_state: string | null; native_country: string | null
  occupation: string | null; occupation_detail: string | null; education: string | null; bio: string | null
  photo_url: string | null; node_state: string; claimed_by: string | null
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
  const [{ rows: persons }, { rows: rels }, { rows: [membership] }] = await Promise.all([
    query<DBPerson>(
      // Fetch this family's own persons PLUS any cross-family persons that are
      // directly referenced by this family's relationship rows.  This makes
      // merged canonical nodes (whose primary_family_id belongs to another
      // family) visible in the graph after a merge.
      `SELECT DISTINCT
              p.id, p.person_code, p.primary_family_id, p.node_state, p.claimed_by, p.created_by, p.visibility,
              p.full_name, p.first_name, p.middle_name, p.last_name, p.name_native, p.nickname,
              p.gender, p.gotra, p.religion,
              p.birth_date, p.birth_year, p.birth_place,
              p.is_alive, p.death_date, p.death_year, p.death_place,
              p.phone, p.whatsapp, p.email,
              p.current_address, p.current_city, p.current_state, p.current_country, p.current_pincode,
              p.native_village, p.native_tehsil, p.native_district, p.native_state, p.native_country,
              p.occupation, p.occupation_detail, p.education, p.bio,
              p.photo_url
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
      canDelete:          p.primary_family_id === userFamilyId && p.claimed_by !== userId,
      canInvite:          p.primary_family_id === userFamilyId && p.node_state === 'proxy' && p.is_alive,
      firstName:          p.first_name,
      middleName:         p.middle_name,
      lastName:           p.last_name,
      nameNative:         p.name_native,
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
