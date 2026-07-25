// Pre-flight check for migration 028 (1:1 user↔node ownership). Reports any
// rows that would violate the two unique indexes BEFORE they're created, so a
// failed migration never leaves you guessing which data is bad.
//
//   uq_persons_claimed_by → one active node per user
//   uq_users_person_id    → one user per node
//
// Usage:
//   npx ts-node scripts/check-owner-dupes.ts
// Exit 0 = clean (safe to migrate); exit 1 = duplicates found (fix first).
import dotenv from 'dotenv'
import pool, { query } from '../src/utils/db'

dotenv.config()

async function main() {
  // 1. One user claiming more than one active (non-deleted) node.
  const claimedBy = await query<{ claimed_by: string; count: string; person_ids: string[] }>(
    `SELECT claimed_by, COUNT(*) AS count, array_agg(id ORDER BY created_at) AS person_ids
     FROM   persons
     WHERE  claimed_by IS NOT NULL AND deleted_at IS NULL
     GROUP  BY claimed_by
     HAVING COUNT(*) > 1
     ORDER  BY COUNT(*) DESC`,
  )

  // 2. One node pointed at by more than one user row.
  const personId = await query<{ person_id: string; count: string; user_ids: string[] }>(
    `SELECT person_id, COUNT(*) AS count, array_agg(id ORDER BY created_at) AS user_ids
     FROM   users
     WHERE  person_id IS NOT NULL
     GROUP  BY person_id
     HAVING COUNT(*) > 1
     ORDER  BY COUNT(*) DESC`,
  )

  const claimedRows = claimedBy.rows
  const personRows  = personId.rows

  if (claimedRows.length === 0 && personRows.length === 0) {
    console.log('✓ No ownership duplicates — safe to run migration 028.')
    return
  }

  if (claimedRows.length > 0) {
    console.log(`\n✗ ${claimedRows.length} user(s) claim more than one active node`)
    console.log('  (would violate uq_persons_claimed_by):')
    for (const r of claimedRows) {
      console.log(`    user ${r.claimed_by} → ${r.count} nodes: ${r.person_ids.join(', ')}`)
    }
  }

  if (personRows.length > 0) {
    console.log(`\n✗ ${personRows.length} node(s) are pointed at by more than one user`)
    console.log('  (would violate uq_users_person_id):')
    for (const r of personRows) {
      console.log(`    person ${r.person_id} ← ${r.count} users: ${r.user_ids.join(', ')}`)
    }
  }

  console.log('\nResolve these (decide the true owner, clear the others) before migrating.')
  process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('❌ Duplicate check failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
