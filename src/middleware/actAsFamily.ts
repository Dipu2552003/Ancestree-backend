import type { Request, Response, NextFunction } from 'express'
import { query } from '../utils/db'
import { asyncHandler } from './asyncHandler'
import { LEVEL } from '../utils/accessLevels'

/**
 * Cross-cluster admin writes.
 *
 * Every person/relationship write scopes to `req.user.familyId` (the requester's
 * own cluster). When a community owner/admin edits or adds a relation on a node
 * in ANOTHER cluster, the client sends `X-Act-Family` with that node's family id.
 * We swap `req.user.familyId` to it — but ONLY after verifying the requester is
 * owner/admin of that family's community (and that it's the same community as the
 * requester's own family). The header can never grant access on its own.
 *
 * If the header is absent, equal, or the check fails, `familyId` is left as-is —
 * the downstream service then scopes to the requester's own family and 404s the
 * cross-cluster node exactly as before. No 403 is raised here; the service's own
 * "person not found in your family" is the correct signal.
 */
export const actAsFamily = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const target = req.header('x-act-family')
  if (!target || target === req.user.familyId) return next()

  const { rows: [row] } = await query<{ level: number }>(
    `SELECT cm.level
     FROM   families f
     JOIN   community_members cm ON cm.community_id = f.community_id AND cm.user_id = $2
     WHERE  f.id = $1 AND f.deleted_at IS NULL
       AND  f.community_id = (SELECT community_id FROM families WHERE id = $3)`,
    [target, req.user.userId, req.user.familyId],
  )
  // Cross-cluster writes require Admin (level 3) or Owner (4) in that community.
  if (row && row.level >= LEVEL.ADMIN) {
    req.user.familyId = target
  }
  next()
})
