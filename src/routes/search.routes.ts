import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { searchPersons, searchPublicPersons } from '../services/search.service'

const router = Router()

// Public, unauthenticated — landing-page search across PUBLIC family trees only.
// Registered before requireAuth so guests can use it; private/community trees
// are excluded by the service.
router.get('/public', asyncHandler(async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const results = await searchPublicPersons(q)
  res.json(results)
}))

router.use(requireAuth)

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const rawScope = req.query.scope
  const scope = rawScope === 'external' ? 'external'
              : rawScope === 'own'      ? 'own'
                                        : 'all'
  // Community users only see results within their walled garden
  const communityId = req.user.communityId ?? null
  const results = await searchPersons(q, req.user.familyId, scope, communityId)
  res.json(results)
}))

export default router
