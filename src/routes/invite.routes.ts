import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { claimByToken, lookupToken } from '../services/invite.service'
import { signupViaInvite } from '../services/auth.service'
import { signToken } from '../utils/jwt'

const router = Router()

// Public — preview who you're about to claim
router.get('/lookup', async (req: Request, res: Response) => {
  const token = req.query.token as string
  if (!token) { res.status(400).json({ error: 'token is required' }); return }
  try {
    const result = await lookupToken(token)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

// Protected — must be logged in to claim
router.post('/claim', requireAuth, async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string }
  if (!token) { res.status(400).json({ error: 'token is required' }); return }
  try {
    const result = await claimByToken(token, req.user.userId)
    const newToken = signToken({ userId: req.user.userId, familyId: result.family_id })
    res.json({ ...result, token: newToken })
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

// New user signing up via invite — no separate family created
router.post('/signup-and-claim', async (req: Request, res: Response) => {
  const { email, password, display_name, invite_token } = req.body as {
    email?: string; password?: string; display_name?: string; invite_token?: string
  }
  if (!email || !password || !display_name || !invite_token) {
    res.status(400).json({ error: 'email, password, display_name and invite_token are required' })
    return
  }
  try {
    const result = await signupViaInvite({ email, password, display_name, invite_token })
    res.status(201).json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
