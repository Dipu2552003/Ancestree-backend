import { Router, Request, Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { badRequest } from '../utils/errors'
import { claimByToken, lookupToken, sendClaimCode } from '../services/invite.service'
import { peekSignupCode } from '../services/community.service'
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

// Public — email a 6-digit OTP for the branded claim flow (validates the token
// and that the email is unregistered before sending).
router.post('/send-code', asyncHandler(async (req: Request, res: Response) => {
  const { email, token } = req.body as { email?: string; token?: string }
  if (!email || !token) throw badRequest('email and token are required')
  res.json(await sendClaimCode(token, email))
}))

// Public — confirm the OTP without consuming it (signup-and-claim consumes it).
router.post('/verify-code', asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = req.body as { email?: string; code?: string }
  if (!email || !code) throw badRequest('email and code are required')
  res.json(await peekSignupCode(email, code))
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

// New user signing up via invite — no separate family created. `code` (email
// OTP) and profile fields are optional: the branded /claim flow sends them, the
// legacy Ancestree /invite page does not.
router.post('/signup-and-claim', asyncHandler(async (req: Request, res: Response) => {
  const { email, password, display_name, invite_token, code,
          gotra, native_village, current_city, photo_url } = req.body as {
    email?: string; password?: string; display_name?: string; invite_token?: string
    code?: string; gotra?: string; native_village?: string; current_city?: string; photo_url?: string
  }
  if (!email || !password || !display_name || !invite_token) {
    throw badRequest('email, password, display_name and invite_token are required')
  }
  const result = await signupViaInvite({
    email, password, display_name, tree_type: 'public', invite_token,
    code, gotra, native_village, current_city, photo_url,
  })
  res.status(201).json(result)
}))

export default router
