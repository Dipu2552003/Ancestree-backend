import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { createPersonSchema, updatePersonSchema } from '../schemas/person.schema'
import { createPerson, getPersonById, updatePerson, deletePerson } from '../services/persons.service'

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

export default router
