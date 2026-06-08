import { Router, Request, Response } from 'express'
import {
  signupSchema, loginSchema, checkEmailSchema,
  changeEmailSchema, changePasswordSchema,
  forgotPasswordSchema, resetPasswordSchema,
} from '../schemas/auth.schema'
import {
  signup, login, getMe, refreshToken, checkEmail,
  changeEmail, changePassword, requestPasswordReset, resetPassword,
} from '../services/auth.service'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/signup', async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await signup(parsed.data)
    res.status(201).json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.post('/check-email', async (req: Request, res: Response) => {
  const parsed = checkEmailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await checkEmail(parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await login(parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await getMe(req.user.userId)
    res.json(user)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/auth/refresh-token — re-issue JWT with the correct familyId after a merge */
router.post('/refresh-token', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await refreshToken(req.user.userId)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** PATCH /api/auth/email — change the authenticated user's email (current password required) */
router.patch('/email', requireAuth, async (req: Request, res: Response) => {
  const parsed = changeEmailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await changeEmail(req.user.userId, parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** PATCH /api/auth/password — change password (current password required) */
router.patch('/password', requireAuth, async (req: Request, res: Response) => {
  const parsed = changePasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await changePassword(req.user.userId, parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/auth/forgot-password — start the reset flow. Always responds 200 to
 *  avoid leaking which emails are registered. */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await requestPasswordReset(parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

/** POST /api/auth/reset-password — complete the reset flow with the emailed token */
router.post('/reset-password', async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message })
    return
  }
  try {
    const result = await resetPassword(parsed.data)
    res.json(result)
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
  }
})

export default router
