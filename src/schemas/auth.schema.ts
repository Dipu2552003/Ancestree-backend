import { z } from 'zod'

export const signupSchema = z.object({
  email:        z.string().email(),
  password:     z.string().min(8, 'Password must be at least 8 characters'),
  display_name: z.string().min(1).max(100),
  // 'public'  → anyone on the platform can discover this tree (default)
  // 'private' → no external search or discovery; invite-only access
  tree_type:    z.enum(['public', 'private']).default('public'),
})

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const checkEmailSchema = z.object({
  email: z.string().email(),
})

export const changeEmailSchema = z.object({
  new_email:        z.string().email(),
  current_password: z.string().min(1),
})

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password:     z.string().min(8, 'Password must be at least 8 characters'),
})

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
})

export const resetPasswordSchema = z.object({
  token:        z.string().min(20),
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
})

export type SignupInput = z.infer<typeof signupSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type CheckEmailInput = z.infer<typeof checkEmailSchema>
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
