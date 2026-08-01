// Cloudflare R2 photo storage (private bucket, S3-compatible API).
//
// Photos live under a deterministic, unguessable key derived from the person
// UUID: `persons/<id>/photo.jpg` (+ `/thumb.jpg`). The bucket is PRIVATE —
// nothing is publicly fetchable. The DB column stores a stable app URL
// (`<BACKEND_PUBLIC_URL>/api/photos/<id>/<variant>`); that route 302-redirects
// to a short-lived presigned R2 URL (see routes/photos.routes.ts). So the only
// thing holding R2 credentials is this backend.
//
// Back-compat: during migration, rows still hold `data:` URLs. The write path
// only rewrites values that ARE data URLs; everything else is left untouched,
// so key rows and legacy data-URL rows coexist safely.

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { query } from './db'
import { logger } from './logger'

export type PhotoVariant = 'photo' | 'thumb'

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  BACKEND_PUBLIC_URL,
} = process.env

/** True only when every R2 var is set — otherwise the write path leaves the
 *  data URL inline so local dev without R2 keeps working. */
export const r2Enabled = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && BACKEND_PUBLIC_URL,
)

let _client: S3Client | null = null
function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    })
  }
  return _client
}

export function photoKey(personId: string, variant: PhotoVariant): string {
  return `persons/${personId}/${variant}.jpg`
}

/** Stable app URL stored in the DB and handed to the frontend. */
export function mediaUrl(personId: string, variant: PhotoVariant): string {
  return `${BACKEND_PUBLIC_URL}/api/photos/${personId}/${variant}`
}

/** Parse a `data:<mime>[;base64],<payload>` URL into bytes + content type.
 *  Returns null for anything that isn't a data URL. */
export function parseDataUrl(value: string): { body: Buffer; contentType: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value)
  if (!m) return null
  const [, contentType, isBase64, data] = m
  const body = isBase64
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data), 'utf8')
  return { body, contentType }
}

/** If `value` is a data URL, upload it to R2 and return the stable media URL.
 *  Otherwise return it untouched (already a media URL, empty string, or null). */
export async function storePhotoIfDataUrl(
  personId: string,
  variant: PhotoVariant,
  value: string | null | undefined,
): Promise<string | null | undefined> {
  if (!r2Enabled || typeof value !== 'string') return value
  const parsed = parseDataUrl(value)
  if (!parsed) return value
  await client().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: photoKey(personId, variant),
    Body: parsed.body,
    ContentType: parsed.contentType,
  }))
  return mediaUrl(personId, variant)
}

/** Short-lived presigned GET URL for a person's photo (default 1h). */
export function presignPhoto(personId: string, variant: PhotoVariant, expiresIn = 3600): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: photoKey(personId, variant) }),
    { expiresIn },
  )
}

// Run-once boot backfill: move any photos still stored inline as `data:` URLs
// into R2 and rewrite the column to the media URL. Self-guards via a
// schema_migrations marker (same pattern as backfillFamilyHeadsOnce) so it
// runs once per database, then never again. The `npm run backfill:photos`
// script shares storePhotoIfDataUrl and remains available for manual runs.
const BACKFILL_MARKER = 'r2_photo_backfill'

export async function backfillPhotosToR2Once(): Promise<void> {
  if (!r2Enabled) return  // not configured yet — retry on a future boot once it is
  const { rows: done } = await query(
    `SELECT 1 FROM schema_migrations WHERE filename = $1`, [BACKFILL_MARKER],
  )
  if (done.length > 0) return

  let migrated = 0
  for (;;) {
    const { rows } = await query<{ id: string; photo_url: string | null; photo_thumbnail_url: string | null }>(
      `SELECT id, photo_url, photo_thumbnail_url FROM persons
       WHERE photo_url LIKE 'data:%' OR photo_thumbnail_url LIKE 'data:%' LIMIT 200`,
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
    }
  }

  await query(
    `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
    [BACKFILL_MARKER],
  )
  logger.info({ migrated }, 'R2 photo backfill complete (run-once)')
}
