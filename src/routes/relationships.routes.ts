import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  createRelationshipSchema, updateRelationshipSchema,
  type CreateRelationshipInput, type UpdateRelationshipInput,
} from '../schemas/relationship.schema'
import {
  createRelationship, getRelationshipById,
  deleteRelationship, updateRelationship,
} from '../services/relationships.service'

const router = Router()
router.use(requireAuth)

router.post('/', validate(createRelationshipSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as CreateRelationshipInput
  const rel = await createRelationship(input, req.user.userId, req.user.familyId)
  res.status(201).json(rel)
}))

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const rel = await getRelationshipById(req.params.id as string, req.user.familyId)
  res.json(rel)
}))

router.patch('/:id', validate(updateRelationshipSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as UpdateRelationshipInput
  const rel = await updateRelationship(req.params.id as string, input, req.user.userId, req.user.familyId)
  res.json(rel)
}))

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteRelationship(req.params.id as string, req.user.userId, req.user.familyId)
  res.json(result)
}))

export default router
