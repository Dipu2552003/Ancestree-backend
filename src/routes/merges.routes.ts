import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { createMergeRequest, acceptMerge, rejectMerge, listSentMergeRequests } from '../services/merge.service'

const router = Router()
router.use(requireAuth)

/** GET /api/merges/sent — list merge requests initiated by the current user */
router.get('/sent', async (req: Request, res: Response) => {
  try {
    const requests = await listSentMergeRequests(req.user.userId)
    res.json({ requests })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/merges — create a merge request */
router.post('/', async (req: Request, res: Response) => {
  const { new_person_id, canonical_person_id } = req.body
  if (!new_person_id || !canonical_person_id) {
    res.status(400).json({ error: 'new_person_id and canonical_person_id are required' })
    return
  }
  try {
    const result = await createMergeRequest(
      new_person_id,
      canonical_person_id,
      req.user.userId,
      req.user.familyId,
    )
    res.status(201).json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/merges/:id/accept — execute the merge */
router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const result = await acceptMerge(req.params.id as string, req.user.userId)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/merges/:id/reject — decline the merge */
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    await rejectMerge(req.params.id as string, req.user.userId)
    res.json({ success: true })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
