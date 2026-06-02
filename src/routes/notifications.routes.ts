import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { getNotifications, countUnread, markRead, markAllRead } from '../services/notification.service'

const router = Router()
router.use(requireAuth)

/** GET /api/notifications — list for current user */
router.get('/', async (req: Request, res: Response) => {
  try {
    const [notifications, unread] = await Promise.all([
      getNotifications(req.user.userId),
      countUnread(req.user.userId),
    ])
    res.json({ notifications, unread_count: unread })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/notifications/:id/read — mark one as read */
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    await markRead(req.params.id as string, req.user.userId)
    res.json({ success: true })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/notifications/read-all — mark all as read */
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    await markAllRead(req.user.userId)
    res.json({ success: true })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
