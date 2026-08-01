// One-time backfill: move photos still stored inline as `data:` URLs in the
// persons table into Cloudflare R2, rewriting the column to the stable media
// URL. Idempotent + resumable — only `data:%` rows are touched, and a row
// leaves the working set only after its UPDATE commits, so a crash mid-run is
// safe to re-run (already-migrated rows are skipped; re-uploads overwrite the
// same deterministic key).
//
//   npm run backfill:photos
//
import dotenv from 'dotenv'
dotenv.config()

import { query } from '../src/utils/db'
import { storePhotoIfDataUrl, r2Enabled } from '../src/utils/r2'

const BATCH = 200

async function run(): Promise<void> {
  if (!r2Enabled) {
    console.error('R2 is not configured (check R2_* + BACKEND_PUBLIC_URL in .env). Aborting.')
    process.exit(1)
  }

  let migrated = 0
  for (;;) {
    const { rows } = await query<{ id: string; photo_url: string | null; photo_thumbnail_url: string | null }>(
      `SELECT id, photo_url, photo_thumbnail_url
       FROM   persons
       WHERE  photo_url LIKE 'data:%' OR photo_thumbnail_url LIKE 'data:%'
       LIMIT  $1`,
      [BATCH],
    )
    if (rows.length === 0) break

    for (const r of rows) {
      const newPhoto = await storePhotoIfDataUrl(r.id, 'photo', r.photo_url)
      const newThumb = await storePhotoIfDataUrl(r.id, 'thumb', r.photo_thumbnail_url)
      await query(
        `UPDATE persons SET photo_url = $1, photo_thumbnail_url = $2, updated_at = NOW() WHERE id = $3`,
        [newPhoto ?? null, newThumb ?? null, r.id],
      )
      migrated++
      if (migrated % 50 === 0) console.log(`  …${migrated} migrated`)
    }
  }

  console.log(`Done. Migrated ${migrated} person photo(s) to R2.`)
  process.exit(0)
}

run().catch(err => { console.error(err); process.exit(1) })
