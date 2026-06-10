import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { getNotifications, countUnread, markRead, markAllRead } from '../services/notification.service'

const router = Router()
router.use(requireAuth)

/** GET /api/notifications — list for current user */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const [notifications, unread] = await Promise.all([
    getNotifications(req.user.userId),
    countUnread(req.user.userId),
  ])
  res.json({ notifications, unread_count: unread })
}))

/** POST /api/notifications/:id/read — mark one as read */
router.post('/:id/read', asyncHandler(async (req: Request, res: Response) => {
  await markRead(req.params.id as string, req.user.userId)
  res.json({ success: true })
}))

/** POST /api/notifications/read-all — mark all as read */
router.post('/read-all', asyncHandler(async (req: Request, res: Response) => {
  await markAllRead(req.user.userId)
  res.json({ success: true })
}))

export default router
