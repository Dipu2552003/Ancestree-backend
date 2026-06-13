import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { updateFamilyVisibility, getFamilyAdmins, addFamilyAdmin } from '../services/family.service'

const router = Router()

const visibilitySchema = z.object({
  visibility: z.enum(['public', 'private']),
})

const addAdminSchema = z.object({
  person_id: z.string().uuid(),
})

/**
 * PATCH /api/family/:id/visibility
 * Toggle a public-platform family between discoverable ('public') and
 * invisible ('private'). Cascades to all persons in the family.
 * Requires family admin role.
 */
router.patch('/:id/visibility', requireAuth, validate(visibilitySchema), asyncHandler(async (req: Request, res: Response) => {
  const { visibility } = req.validated as { visibility: 'public' | 'private' }
  const result = await updateFamilyVisibility(req.params['id'] as string, visibility, req.user.userId)
  res.json(result)
}))

/**
 * GET /api/family/:id/admins — community feature.
 * Lists the family's admins. Any member of the family's community may view;
 * `can_manage` tells the client whether the requester can promote others.
 */
router.get('/:id/admins', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getFamilyAdmins(req.params['id'] as string, req.user.userId)
  res.json(result)
}))

/**
 * POST /api/family/:id/admins — community feature.
 * Promote a claimed (owned) node's account to family admin.
 * Requires the requester to already be an admin of this family.
 */
router.post('/:id/admins', requireAuth, validate(addAdminSchema), asyncHandler(async (req: Request, res: Response) => {
  const { person_id } = req.validated as { person_id: string }
  const result = await addFamilyAdmin(req.params['id'] as string, person_id, req.user.userId)
  res.json(result)
}))

export default router
