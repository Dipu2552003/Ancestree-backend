import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { createPersonSchema, updatePersonSchema } from '../schemas/person.schema'
import { createPerson, getPersonById, updatePerson, deletePerson, generateInviteToken } from '../services/persons.service'
import { reparentChildren } from '../services/relationships.service'

const reparentSchema = z.object({
  changes: z.array(z.object({
    child_id:      z.string().uuid(),
    new_mother_id: z.string().uuid().nullable(),
  })).min(1),
})

const router = Router()
router.use(requireAuth)

router.post('/', async (req: Request, res: Response) => {
  const parsed = createPersonSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const person = await createPerson(parsed.data, req.user.userId, req.user.familyId)
    res.status(201).json(person)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const person = await getPersonById(req.params.id as string, req.user.familyId)
    res.json(person)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.patch('/:id', async (req: Request, res: Response) => {
  const parsed = updatePersonSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const person = await updatePerson(req.params.id as string, parsed.data, req.user.userId, req.user.familyId)
    res.json(person)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await deletePerson(req.params.id as string, req.user.userId, req.user.familyId)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/**
 * Re-mother a set of children (Flow E Phase 3).
 *   :id           = the father whose existing children we're reassigning
 *   body.changes  = [{ child_id, new_mother_id|null }, …]
 *
 * For each change, drops the child's current mother PARENT_OF edge (if any)
 * and inserts a new one to new_mother_id. Null new_mother_id = "Unknown" so
 * no new mother edge is created. The father edge is left untouched.
 */
router.post('/:id/reparent', async (req: Request, res: Response) => {
  const parsed = reparentSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await reparentChildren(
      req.params.id as string,
      parsed.data.changes,
      req.user.userId,
      req.user.familyId,
    )
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.post('/:id/invite', async (req: Request, res: Response) => {
  try {
    const result = await generateInviteToken(req.params.id as string, req.user.userId, req.user.familyId)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
