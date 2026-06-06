import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { searchPersons } from '../services/search.service'

const router = Router()
router.use(requireAuth)

router.get('/', async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const rawScope = req.query.scope
    const scope = rawScope === 'external' ? 'external'
                : rawScope === 'own'      ? 'own'
                                          : 'all'
    const results = await searchPersons(q, req.user.familyId, scope)
    res.json(results)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
