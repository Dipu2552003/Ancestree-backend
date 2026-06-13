// Mounted at /api/family — operation history + undo for the safety net.
//
//   GET  /api/family/:id/history                      → grouped operation list
//   POST /api/family/:id/history/:operationId/undo    → revert one operation

import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { forbidden } from '../utils/errors'
import * as familyMembersRepo from '../repositories/familyMembers.repo'
import { getFamilyHistory, undoOperation } from '../services/history.service'

const router = Router()
router.use(requireAuth)

/** The JWT family is allowed implicitly; any other family needs a membership row. */
async function assertFamilyAccess(familyId: string, user: { userId: string; familyId: string }): Promise<void> {
  if (user.familyId === familyId) return
  const member = await familyMembersRepo.exists(familyId, user.userId)
  if (!member) throw forbidden('You are not a member of this family')
}

router.get('/:id/history', asyncHandler(async (req: Request, res: Response) => {
  const familyId = req.params.id as string
  await assertFamilyAccess(familyId, req.user)

  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50

  const operations = await getFamilyHistory(familyId, limit)
  res.json({ operations })
}))

router.post('/:id/history/:operationId/undo', asyncHandler(async (req: Request, res: Response) => {
  const familyId = req.params.id as string
  await assertFamilyAccess(familyId, req.user)

  const result = await undoOperation(req.params.operationId as string, req.user.userId, familyId)
  res.json(result)
}))

export default router
