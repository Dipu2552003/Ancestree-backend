import { Router, Request, Response } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { presignPhoto, r2Enabled, type PhotoVariant } from '../utils/r2'

const router = Router()

// Public + unauthenticated: an <img> tag can't send auth headers. Access is
// gated by the unguessable person UUID in the path — the same model as a
// signed profile-photo URL. The bucket stays private; this route mints a
// short-lived presigned R2 link and 302-redirects the browser to it.
router.get('/:id/:variant', asyncHandler(async (req: Request, res: Response) => {
  if (!r2Enabled) { res.status(404).end(); return }
  const id = String(req.params.id)
  const variant = String(req.params.variant)
  if (variant !== 'photo' && variant !== 'thumb') { res.status(404).end(); return }

  const url = await presignPhoto(id, variant as PhotoVariant)
  // helmet() sets CORP: same-origin globally, which blocks the frontend (a
  // different origin) from embedding this <img>. Photos are meant to be
  // embedded cross-origin, so relax it for this route only.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin')
  // Cache the redirect briefly so a tree re-render doesn't re-sign every photo;
  // well under the 1h signature TTL so the target never goes stale mid-cache.
  res.set('Cache-Control', 'private, max-age=300')
  res.redirect(302, url)
}))

export default router
