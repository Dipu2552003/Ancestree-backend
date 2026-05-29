import { query } from '../utils/db'


interface DBPerson {
  id: string; full_name: string; first_name: string | null; gender: string | null
  birth_year: number | null; birth_place: string | null
  death_year: number | null; is_alive: boolean
  photo_url: string | null; node_state: string; claimed_by: string | null
  created_by: string; visibility: string; person_code: string
  nickname: string | null; gotra: string | null; native_village: string | null
  current_city: string | null; current_country: string | null
  occupation: string | null; bio: string | null; education: string | null
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

export async function fetchFamilyGraph(familyId: string, userId: string) {
  const [{ rows: persons }, { rows: rels }, { rows: [membership] }] = await Promise.all([
    query<DBPerson>(
      `SELECT id, full_name, first_name, gender, birth_year, birth_place, death_year, is_alive,
              photo_url, node_state, claimed_by, created_by, visibility, person_code,
              nickname, gotra, native_village, current_city, current_country,
              occupation, bio, education
       FROM persons
       WHERE primary_family_id = $1 AND deleted_at IS NULL`,
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

  const selfPerson = persons.find(p => p.claimed_by === userId)
  const selfId = selfPerson?.id ?? persons[0]?.id

  if (!selfId) return { nodes: [], edges: [], meta: { totalNodes: 0 } }

  const relToSelf = computeRelToSelf(selfId, persons, rels)

  const nodes = persons.map(p => ({
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
      isSelf:             p.claimed_by === userId,
      isDeceased:         !p.is_alive,
      relationshipToSelf: relToSelf.get(p.id) ?? '',
      canEdit:            p.claimed_by ? p.claimed_by === userId : p.created_by === userId,
      canDelete:          p.claimed_by !== userId && (isAdmin || p.created_by === userId),
      canInvite:          p.node_state === 'proxy' && p.is_alive,
      nickname:           p.nickname,
      gender:             p.gender,
      birthPlace:         p.birth_place,
      gotra:              p.gotra,
      nativeVillage:      p.native_village,
      currentCity:        p.current_city,
      currentCountry:     p.current_country,
      occupation:         p.occupation,
      bio:                p.bio,
      education:          p.education,
    },
  }))

  const edges = rels.map(r => ({
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

  return {
    nodes,
    edges,
    meta: { totalNodes: nodes.length },
  }
}
