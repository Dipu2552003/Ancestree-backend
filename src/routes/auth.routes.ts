import { Router, Request, Response } from 'express'
import {
  signupSchema, loginSchema, checkEmailSchema,
  changeEmailSchema, changePasswordSchema,
  forgotPasswordSchema, resetPasswordSchema,
  type SignupInput, type LoginInput, type CheckEmailInput,
  type ChangeEmailInput, type ChangePasswordInput,
  type ForgotPasswordInput, type ResetPasswordInput,
} from '../schemas/auth.schema'
import {
  signup, login, getMe, refreshToken, checkEmail,
  changeEmail, changePassword, requestPasswordReset, resetPassword,
} from '../services/auth.service'
import { requireAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import { authLimiter, signupLimiter } from '../middleware/rateLimit'

const router = Router()

router.post('/signup', signupLimiter, validate(signupSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await signup(req.validated as SignupInput)
  res.status(201).json(result)
}))

router.post('/check-email', signupLimiter, validate(checkEmailSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await checkEmail(req.validated as CheckEmailInput)
  res.json(result)
}))

router.post('/login', authLimiter, validate(loginSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await login(req.validated as LoginInput)
  res.json(result)
}))

router.get('/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = await getMe(req.user.userId)
  res.json(user)
}))

/** POST /api/auth/refresh-token — re-issue JWT with the correct familyId after a merge */
router.post('/refresh-token', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await refreshToken(req.user.userId)
  res.json(result)
}))

/** PATCH /api/auth/email — change the authenticated user's email (current password required) */
router.patch('/email', requireAuth, validate(changeEmailSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await changeEmail(req.user.userId, req.validated as ChangeEmailInput)
  res.json(result)
}))

/** PATCH /api/auth/password — change password (current password required) */
router.patch('/password', requireAuth, validate(changePasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await changePassword(req.user.userId, req.validated as ChangePasswordInput)
  res.json(result)
}))

/** POST /api/auth/forgot-password — start the reset flow. Always responds 200 to
 *  avoid leaking which emails are registered. */
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await requestPasswordReset(req.validated as ForgotPasswordInput)
  res.json(result)
}))

/** POST /api/auth/reset-password — complete the reset flow with the emailed token */
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await resetPassword(req.validated as ResetPasswordInput)
  res.json(result)
}))

export default router
