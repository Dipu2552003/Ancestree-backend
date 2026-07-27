// One-time backfill: populate persons.family_head_id for every existing family.
// Idempotent and resumable — safe to run repeatedly. Run once after migration
// 030 is applied and the backend is deployed:
//
//   npm run backfill:family-heads
//
import * as dotenv from 'dotenv'
import { query } from '../src/utils/db'
import { recomputeFamilyHeads } from '../src/services/familyHead.service'
import { logger } from '../src/utils/logger'

dotenv.config()

async function main() {
  const { rows: families } = await query<{ id: string }>(
    `SELECT id FROM families WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  )
  logger.info({ families: families.length }, 'backfill: start')

  let done = 0
  for (const f of families) {
    try {
      await recomputeFamilyHeads(f.id)
      done++
      if (done % 25 === 0) logger.info({ done, total: families.length }, 'backfill: progress')
    } catch (err) {
      logger.error({ err, familyId: f.id }, 'backfill: family failed (continuing)')
    }
  }

  logger.info({ done, total: families.length }, 'backfill: complete')
  process.exit(0)
}

main().catch(err => {
  logger.error({ err }, 'backfill: fatal')
  process.exit(1)
})
