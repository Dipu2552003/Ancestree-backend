import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  createPersonSchema, updatePersonSchema,
  type CreatePersonInput, type UpdatePersonInput,
} from '../schemas/person.schema'
import {
  createPerson, getPersonById, updatePerson, deletePerson, generateInviteToken,
} from '../services/persons.service'
import { reparentChildren } from '../services/relationships.service'

const reparentSchema = z.object({
  changes: z.array(z.object({
    child_id:      z.string().uuid(),
    new_mother_id: z.string().uuid().nullable(),
  })).min(1),
})
type ReparentInput = z.infer<typeof reparentSchema>

const router = Router()
router.use(requireAuth)

router.post('/', validate(createPersonSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as CreatePersonInput
  const person = await createPerson(input, req.user.userId, req.user.familyId)
  res.status(201).json(person)
}))

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const person = await getPersonById(req.params.id as string, req.user.familyId)
  res.json(person)
}))

router.patch('/:id', validate(updatePersonSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as UpdatePersonInput
  const person = await updatePerson(req.params.id as string, input, req.user.userId, req.user.familyId)
  res.json(person)
}))

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const result = await deletePerson(req.params.id as string, req.user.userId, req.user.familyId)
  res.json(result)
}))

/**
 * Re-mother a set of children (Flow E Phase 3).
 *   :id           = the father whose existing children we're reassigning
 *   body.changes  = [{ child_id, new_mother_id|null }, …]
 *
 * For each change, drops the child's current mother PARENT_OF edge (if any)
 * and inserts a new one to new_mother_id. Null new_mother_id = "Unknown" so
 * no new mother edge is created. The father edge is left untouched.
 */
router.post('/:id/reparent', validate(reparentSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as ReparentInput
  const result = await reparentChildren(
    req.params.id as string,
    input.changes,
    req.user.userId,
    req.user.familyId,
  )
  res.json(result)
}))

router.post('/:id/invite', asyncHandler(async (req: Request, res: Response) => {
  const result = await generateInviteToken(req.params.id as string, req.user.userId, req.user.familyId)
  res.json(result)
}))

export default router
