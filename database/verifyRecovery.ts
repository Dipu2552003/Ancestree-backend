// Recovery verification — the end-to-end test that proves the safety net holds.
//
//   1. Create a scratch user + family (signup) and a small tree.
//   2. Run a multi-row operation (person delete → edge cleanup + node soft-delete).
//   3. Confirm one operation_id covers all of its audit rows.
//   4. Undo it → confirm the exact pre-operation state is restored.
//   5. Confirm the undo was itself logged and the target stamped reverted_by.
//   6. Undo the undo → confirm the original (deleted) state returns and the
//      first operation is undoable again.
//   7. Force a mid-operation failure → confirm zero trace (no data, no logs).
//   8. Clean up every scratch row.
//
// Run: npm run verify:recovery   (needs DATABASE_URL, migrations applied)

import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()

import pool, { query } from '../src/utils/db'
import { withOperation, captureAndUpdate } from '../src/utils/audit'
import { signup } from '../src/services/auth.service'
import { createPerson, deletePerson } from '../src/services/persons.service'
import { createRelationship } from '../src/services/relationships.service'
import { undoOperation, getFamilyHistory } from '../src/services/history.service'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function personRow(id: string) {
  const { rows: [p] } = await query<{ id: string; full_name: string; deleted_at: string | null }>(
    `SELECT id, full_name, deleted_at FROM persons WHERE id = $1`, [id])
  return p
}

async function relRow(id: string) {
  const { rows: [r] } = await query<{ id: string; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM relationships WHERE id = $1`, [id])
  return r
}

async function main() {
  console.log('\n── Recovery verification ──────────────────────────────────\n')

  // ── Setup: scratch family ──────────────────────────────────────────────────
  const email = `recovery-test-${crypto.randomBytes(6).toString('hex')}@example.invalid`
  // Unlikely name so duplicate-search never matches real data.
  const { user } = await signup({ email, password: 'recovery-test-pw-1', display_name: 'Zxqv Recoverytest' } as never)
  const userId = user.id
  const familyId = user.family_id
  const selfId = user.person_id
  console.log(`scratch family ${familyId}\n`)

  const father = await createPerson({ full_name: 'Zxqv Recoverytest Father' } as never, userId, familyId) as unknown as { id: string }
  const rel = await createRelationship(
    { from_person_id: father.id, to_person_id: selfId, rel_type: 'PARENT_OF' } as never,
    userId, familyId,
  ) as unknown as { id: string }

  try {
    // ── 1. Multi-row operation ───────────────────────────────────────────────
    console.log('step 1 — multi-row operation (delete person + edge cleanup)')
    await deletePerson(father.id, userId, familyId)

    const { rows: delRows } = await query<{ operation_id: string; entity_type: string }>(
      `SELECT operation_id, entity_type FROM audit_log
       WHERE family_id = $1 AND action = 'person.delete' ORDER BY seq`,
      [familyId],
    )
    assert(delRows.length >= 2, `operation produced ${delRows.length} audit rows (relationship + person)`)
    const opId = delRows[0].operation_id
    assert(delRows.every(r => r.operation_id === opId), 'all rows share one operation_id')
    assert((await personRow(father.id)).deleted_at !== null, 'person is soft-deleted')
    assert((await relRow(rel.id as string)).deleted_at !== null, 'relationship is soft-deleted')

    // ── 2. Undo ──────────────────────────────────────────────────────────────
    console.log('\nstep 2 — undo the operation')
    const undo1 = await undoOperation(opId, userId, familyId)
    assert((await personRow(father.id)).deleted_at === null, 'person restored (deleted_at cleared)')
    assert((await relRow(rel.id as string)).deleted_at === null, 'relationship restored')

    // ── 3. Undo is logged ────────────────────────────────────────────────────
    console.log('\nstep 3 — undo is itself logged')
    const { rows: undoRows } = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE operation_id = $1`, [undo1.undo_operation_id])
    assert(undoRows.length >= 3, `undo wrote ${undoRows.length} audit rows (2 reverts + marker)`)
    const { rows: stamped } = await query<{ reverted_by: string }>(
      `SELECT reverted_by FROM audit_log WHERE operation_id = $1`, [opId])
    assert(stamped.every(r => r.reverted_by === undo1.undo_operation_id), 'original op stamped reverted_by = undo op')

    const history = await getFamilyHistory(familyId, userId)
    const histEntry = history.find(h => h.operation_id === opId)
    assert(histEntry?.reverted === true && histEntry.can_undo === false, 'history shows the operation as reverted')
    assert(history.some(h => h.action === 'undo'), 'history lists the undo operation')

    // ── 4. Undo the undo ─────────────────────────────────────────────────────
    console.log('\nstep 4 — undo the undo (history is never deleted)')
    await undoOperation(undo1.undo_operation_id, userId, familyId)
    assert((await personRow(father.id)).deleted_at !== null, 'original state returned: person soft-deleted again')
    assert((await relRow(rel.id as string)).deleted_at !== null, 'original state returned: relationship soft-deleted again')
    const { rows: cleared } = await query<{ reverted_by: string | null }>(
      `SELECT reverted_by FROM audit_log WHERE operation_id = $1`, [opId])
    assert(cleared.every(r => r.reverted_by === null), 'original op is undoable again (reverted_by cleared)')

    // ── 5. Forced mid-operation failure leaves zero trace ────────────────────
    console.log('\nstep 5 — forced mid-operation failure')
    let failedOpId = ''
    const nameBefore = (await personRow(father.id)).full_name
    await withOperation({ action: 'person.update', actorId: userId, familyId }, async op => {
      failedOpId = op.operationId
      await captureAndUpdate(op, 'person',
        { sql: 'id = $1', params: [father.id] },
        { sql: `full_name = 'SHOULD NOT PERSIST'` },
      )
      throw new Error('forced mid-operation failure')
    }).catch(() => { /* expected */ })

    const { rows: ghost } = await query(`SELECT 1 FROM audit_log WHERE operation_id = $1`, [failedOpId])
    assert(ghost.length === 0, 'no audit rows from the failed operation')
    assert((await personRow(father.id)).full_name === nameBefore, 'no data change from the failed operation')

    console.log('\n✅ RECOVERY VERIFICATION PASSED — the net holds.\n')
  } finally {
    // ── Cleanup scratch data (hard deletes, FK-safe order) ───────────────────
    await query(`UPDATE users SET person_id = NULL WHERE id = $1`, [userId])
    await query(`DELETE FROM audit_log WHERE family_id = $1`, [familyId])
    await query(`DELETE FROM notifications WHERE user_id = $1`, [userId]).catch(() => {})
    await query(`DELETE FROM relationships WHERE primary_family_id = $1`, [familyId])
    await query(`DELETE FROM family_members WHERE family_id = $1`, [familyId])
    await query(`UPDATE families SET head_person_id = NULL WHERE id = $1`, [familyId]).catch(() => {})
    await query(`DELETE FROM persons WHERE primary_family_id = $1`, [familyId])
    await query(`DELETE FROM families WHERE id = $1`, [familyId])
    await query(`DELETE FROM users WHERE id = $1`, [userId])
    console.log('scratch data cleaned up')
    await pool.end()
  }
}

main().catch(err => {
  console.error('\n❌ RECOVERY VERIFICATION FAILED:', err)
  process.exit(1)
})
