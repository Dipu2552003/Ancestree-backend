import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { badRequest } from '../utils/errors'
import { claimByToken, lookupToken } from '../services/invite.service'
import { signupViaInvite } from '../services/auth.service'
import { signToken } from '../utils/jwt'

const router = Router()

// Public — preview who you're about to claim
router.get('/lookup', asyncHandler(async (req: Request, res: Response) => {
  const token = req.query.token as string
  if (!token) throw badRequest('token is required')
  const result = await lookupToken(token)
  res.json(result)
}))

// Protected — must be logged in to claim
router.post('/claim', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string }
  if (!token) throw badRequest('token is required')
  const result = await claimByToken(token, req.user.userId)
  const newToken = signToken({
    userId: req.user.userId,
    familyId: result.family_id,
    communityId: result.community_id ?? null,
  })
  res.json({ ...result, token: newToken })
}))

// New user signing up via invite — no separate family created
router.post('/signup-and-claim', asyncHandler(async (req: Request, res: Response) => {
  const { email, password, display_name, invite_token } = req.body as {
    email?: string; password?: string; display_name?: string; invite_token?: string
  }
  if (!email || !password || !display_name || !invite_token) {
    throw badRequest('email, password, display_name and invite_token are required')
  }
  const result = await signupViaInvite({ email, password, display_name, tree_type: 'public', invite_token })
  res.status(201).json(result)
}))

export default router
