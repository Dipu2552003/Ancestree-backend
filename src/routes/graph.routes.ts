import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { fetchFamilyGraph } from '../services/graph.service'
import { query } from '../utils/db'

const router = Router()
router.use(requireAuth)

router.get('/', async (req: Request, res: Response) => {
  try {
    const perspective = req.query.perspective as string | undefined
    const userFamilyId = req.user.familyId

    // When perspective points to a person in a different family,
    // fetch that family's graph instead of the user's own family.
    let graphFamilyId = userFamilyId
    if (perspective) {
      const { rows } = await query<{ primary_family_id: string }>(
        `SELECT primary_family_id FROM persons WHERE id = $1 AND deleted_at IS NULL`,
        [perspective]
      )
      if (rows[0]?.primary_family_id) {
        graphFamilyId = rows[0].primary_family_id
      }
    }

    const graph = await fetchFamilyGraph(graphFamilyId, req.user.userId, userFamilyId, perspective)
    res.json(graph)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
