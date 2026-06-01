import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { fetchFamilyGraph } from '../services/graph.service'

const router = Router()
router.use(requireAuth)

router.get('/', async (req: Request, res: Response) => {
  try {
    const perspective = req.query.perspective as string | undefined
    const graph = await fetchFamilyGraph(req.user.familyId, req.user.userId, perspective)
    res.json(graph)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
