import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { fetchFamilyGraph } from '../services/graph.service'
import { query } from '../utils/db'

const router = Router()
router.use(requireAuth)

// Bounded so a malformed client can't force a multi-thousand-generation BFS.
const MAX_DEPTH = 100

function parseDepth(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.floor(n), MAX_DEPTH)
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const perspective = req.query.perspective as string | undefined
  const userFamilyId = req.user.familyId
  const ancestorDepth   = parseDepth(req.query.ancestorDepth,   10)
  const descendantDepth = parseDepth(req.query.descendantDepth, 10)

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

  const graph = await fetchFamilyGraph(
    graphFamilyId, req.user.userId, userFamilyId, perspective,
    ancestorDepth, descendantDepth,
  )
  res.json(graph)
}))

export default router
