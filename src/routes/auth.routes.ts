import { Router, Request, Response } from 'express'
import { signupSchema, loginSchema } from '../schemas/auth.schema'
import { signup, login, getMe, refreshToken } from '../services/auth.service'
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

export default router
