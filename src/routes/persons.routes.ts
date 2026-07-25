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
  bulkUpdatePersons,
} from '../services/persons.service'
import { reparentChildren, reorderChildren } from '../services/relationships.service'

// Admin bulk edit over a set of people (bloodline BFS or a manual multi-select).
// 'bloodline' may set gotra/village; 'selection' may also set current location.
// At least one field must be present — re-checked in the service per scope.
const bulkUpdateSchema = z.object({
  person_ids:       z.array(z.string().uuid()).min(1).max(2000),
  scope:            z.enum(['bloodline', 'selection']),
  gotra:            z.string().max(100).optional(),
  native_village:   z.string().max(120).optional(),
  current_city:     z.string().max(120).optional(),
  current_district: z.string().max(120).optional(),
  current_state:    z.string().max(120).optional(),
  current_country:  z.string().max(120).optional(),
})
type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>

const reparentSchema = z.object({
  changes: z.array(z.object({
    child_id:      z.string().uuid(),
    new_mother_id: z.string().uuid().nullable(),
  })).min(1),
})
type ReparentInput = z.infer<typeof reparentSchema>

const reorderSchema = z.object({
  ordered_child_ids: z.array(z.string().uuid()).min(2),
})
type ReorderInput = z.infer<typeof reorderSchema>

const router = Router()
router.use(requireAuth)

router.post('/', validate(createPersonSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as CreatePersonInput
  const person = await createPerson(input, req.user.userId, req.user.familyId)
  res.status(201).json(person)
}))

// Admin bulk edit (bloodline or manual multi-select) — registered before the
// /:id routes so the literal path can never be shadowed by an :id match.
router.post('/bulk-update', validate(bulkUpdateSchema), asyncHandler(async (req: Request, res: Response) => {
  const { person_ids, scope, ...changes } = req.validated as BulkUpdateInput
  const result = await bulkUpdatePersons(person_ids, scope, changes, req.user.userId)
  res.json(result)
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

/**
 * Manual sibling order (used when birth years are unknown).
 *   :id                     = the parent whose children are being arranged
 *   body.ordered_child_ids  = ALL of that parent's children, eldest first
 */
router.post('/:id/children/reorder', validate(reorderSchema), asyncHandler(async (req: Request, res: Response) => {
  const input = req.validated as ReorderInput
  const result = await reorderChildren(
    req.params.id as string,
    input.ordered_child_ids,
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
