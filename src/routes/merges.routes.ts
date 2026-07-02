import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { badRequest } from '../utils/errors'
import {
  createMergeRequest, acceptMerge, rejectMerge,
  listSentMergeRequests, getMergeById, searchDuplicates,
} from '../services/merge'

const router = Router()
router.use(requireAuth)

/** GET /api/merges/search?name=… — scored duplicate search for the merge-from-node flow */
router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const fullName = typeof req.query.name === 'string' ? req.query.name.trim() : ''
  if (!fullName) { res.json({ results: [] }); return }
  const results = await searchDuplicates({ fullName }, req.user.familyId)
  res.json({ results })
}))

/** GET /api/merges/sent — list merge requests initiated by the current user */
router.get('/sent', asyncHandler(async (req: Request, res: Response) => {
  const requests = await listSentMergeRequests(req.user.userId)
  res.json({ requests })
}))

/** GET /api/merges/:id — details of a specific merge request (must be after /sent) */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const details = await getMergeById(req.params.id as string)
  res.json(details)
}))

/** POST /api/merges — create a merge request */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { new_person_id, canonical_person_id } = req.body
  if (!new_person_id || !canonical_person_id) {
    throw badRequest('new_person_id and canonical_person_id are required')
  }
  const result = await createMergeRequest(
    new_person_id,
    canonical_person_id,
    req.user.userId,
    req.user.familyId,
  )
  res.status(201).json(result)
}))

/** POST /api/merges/:id/accept — execute the merge.
 *  body.keep_data: 'merged' keeps the sender's profile details on the
 *  surviving node; anything else keeps the canonical details (default). */
router.post('/:id/accept', asyncHandler(async (req: Request, res: Response) => {
  const keepData = req.body?.keep_data === 'merged' ? 'merged' : 'canonical'
  const result = await acceptMerge(req.params.id as string, req.user.userId, keepData)
  res.json(result)
}))

/** POST /api/merges/:id/reject — decline the merge */
router.post('/:id/reject', asyncHandler(async (req: Request, res: Response) => {
  await rejectMerge(req.params.id as string, req.user.userId)
  res.json({ success: true })
}))

export default router
