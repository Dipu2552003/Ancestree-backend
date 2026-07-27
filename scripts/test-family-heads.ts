// Self-check for computeFamilyHeads — the patriline partition. No DB, no
// framework. Run:  npm run test:family-heads
import assert from 'assert'
import { computeFamilyHeads, type FHPerson, type FHRel } from '../src/services/familyHead.service'

const P = (id: string, gender: string | null, birth_year: number | null): FHPerson =>
  ({ id, gender, birth_year, person_code: id })
const parentOf = (from: string, to: string): FHRel => ({ from_person_id: from, to_person_id: to, rel_type: 'PARENT_OF' })
const sibling  = (a: string, b: string): FHRel => ({ from_person_id: a, to_person_id: b, rel_type: 'SIBLING_OF' })

let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log('  ✓', name) }

// 1. Straight patriline: grandfather → father → son. One lineage, head = eldest male.
check('patriline collapses to the topmost male', () => {
  const persons = [P('gf', 'male', 1930), P('dad', 'male', 1960), P('son', 'male', 1990)]
  const rels = [parentOf('gf', 'dad'), parentOf('dad', 'son')]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(h.get('gf'), 'gf')
  assert.strictEqual(h.get('dad'), 'gf')
  assert.strictEqual(h.get('son'), 'gf')
  assert.strictEqual(new Set(h.values()).size, 1) // one lineage
})

// 2. Married-in wife whose birth family isn't in the tree → her own lineage (mayka).
//    Her child follows the FATHER's line, never hers.
check('married-in wife is her own lineage; child follows father', () => {
  const persons = [P('dad', 'male', 1960), P('mom', 'female', 1962), P('kid', 'male', 1990)]
  const rels = [
    { from_person_id: 'dad', to_person_id: 'mom', rel_type: 'SPOUSE_OF' }, // ignored
    parentOf('dad', 'kid'), parentOf('mom', 'kid'),
  ]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(h.get('dad'), 'dad')
  assert.strictEqual(h.get('kid'), 'dad')        // father's line, not mother's
  assert.strictEqual(h.get('mom'), 'mom')        // her own mayka lineage
  assert.strictEqual(new Set(h.values()).size, 2) // TWO lineages in one cluster
})

// 3. Two patrilines joined only by a marriage → still two lineages (one cluster).
check('marriage link keeps two lineages', () => {
  const persons = [
    P('mahendra', 'male', 1940), P('m_son', 'male', 1970),
    P('devichand', 'male', 1935), P('d_daughter', 'female', 1972),
  ]
  const rels = [
    parentOf('mahendra', 'm_son'),
    parentOf('devichand', 'd_daughter'),
    { from_person_id: 'm_son', to_person_id: 'd_daughter', rel_type: 'SPOUSE_OF' }, // ignored
  ]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(h.get('m_son'), 'mahendra')
  assert.strictEqual(h.get('d_daughter'), 'devichand')
  assert.strictEqual(new Set(h.values()).size, 2)
})

// 4. Same-bloodline merge: Devichand turns out to be Mahendra's father → ONE lineage,
//    headed by the elder (Devichand).
check('same-bloodline merge collapses to one lineage', () => {
  const persons = [P('mahendra', 'male', 1940), P('m_son', 'male', 1970), P('devichand', 'male', 1915)]
  const rels = [parentOf('devichand', 'mahendra'), parentOf('mahendra', 'm_son')]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(new Set(h.values()).size, 1)
  assert.strictEqual(h.get('m_son'), 'devichand')
})

// 5. Sibling group with no parents in the tree → one lineage, head = eldest male.
check('parentless siblings form one lineage', () => {
  const persons = [P('a', 'male', 1980), P('b', 'female', 1982), P('c', 'male', 1978)]
  const rels = [sibling('a', 'b'), sibling('b', 'c')]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(new Set(h.values()).size, 1)
  assert.strictEqual(h.get('a'), 'c') // c is the eldest male
})

// 6. Single mother, no father → child shares the mother's lineage.
check('single mother: child shares her lineage', () => {
  const persons = [P('mom', 'female', 1960), P('kid', 'female', 1990)]
  const rels = [parentOf('mom', 'kid')]
  const h = computeFamilyHeads(persons, rels)
  assert.strictEqual(new Set(h.values()).size, 1)
  assert.strictEqual(h.get('kid'), 'mom')
})

console.log(`\n${passed} checks passed.`)
