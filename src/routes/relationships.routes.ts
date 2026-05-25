import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { createRelationshipSchema } from '../schemas/relationship.schema'
import { createRelationship, getRelationshipById, deleteRelationship } from '../services/relationships.service'

const router = Router()
router.use(requireAuth)

router.post('/', async (req: Request, res: Response) => {
  const parsed = createRelationshipSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const rel = await createRelationship(parsed.data, req.user.userId, req.user.familyId)
    res.status(201).json(rel)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const rel = await getRelationshipById(req.params.id as string, req.user.familyId)
    res.json(rel)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await deleteRelationship(req.params.id as string, req.user.familyId)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
