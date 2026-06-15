import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { fetchFamilyGraph, fetchPublicFamilyGraph } from '../services/graph.service'
import { query } from '../utils/db'

const router = Router()

// Public, unauthenticated — read-only tree view for the landing-page search.
// Registered before requireAuth so guests can view a PUBLIC person's family
// tree; private/community trees are rejected inside the service.
router.get('/public', asyncHandler(async (req: Request, res: Response) => {
  const perspective = typeof req.query.perspective === 'string' ? req.query.perspective : ''
  if (!perspective) {
    res.status(400).json({ error: 'perspective is required' })
    return
  }
  const graph = await fetchPublicFamilyGraph(perspective)
  res.json(graph)
}))

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

      // Access control for cross-family views.
      // Community families are checked first — membership in the same community
      // grants full access regardless of the family's visibility setting
      // (community families default to 'private' which would otherwise block it).
      if (graphFamilyId !== userFamilyId) {
        const { rows: [fam] } = await query<{ visibility: string; community_id: string | null }>(
          `SELECT visibility, community_id FROM families WHERE id = $1`,
          [graphFamilyId],
        )
        if (fam?.community_id) {
          // Community family: requester must be in the same community.
          const { rows: [sameCommunity] } = await query(
            `SELECT 1 FROM families
             WHERE id = $1 AND community_id = (SELECT community_id FROM families WHERE id = $2)`,
            [userFamilyId, graphFamilyId],
          )
          if (!sameCommunity) {
            res.status(403).json({ error: 'This family tree belongs to a different community' })
            return
          }
        } else if (fam?.visibility === 'private') {
          // Non-community private family: requester must be a member.
          const { rows: [member] } = await query(
            `SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2`,
            [graphFamilyId, req.user.userId],
          )
          if (!member) {
            res.status(403).json({ error: 'This family tree is private' })
            return
          }
        }
      }
    }
  }

  const graph = await fetchFamilyGraph(
    graphFamilyId, req.user.userId, userFamilyId, perspective,
    ancestorDepth, descendantDepth,
  )
  res.json(graph)
}))

export default router
