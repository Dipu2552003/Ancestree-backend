import { z } from 'zod'

export const createCommunitySchema = z.object({
  name:         z.string().min(2).max(100),
  slug:         z.string().min(2).max(50)
                  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, or dashes only'),
  description:  z.string().max(500).optional(),
  member_limit: z.number().int().min(0).default(0),
  owner: z.object({
    email:        z.string().email(),
    password:     z.string().min(8, 'Password must be at least 8 characters'),
    display_name: z.string().min(1).max(100),
  }),
})

export const communityLoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

export const communitySignupSchema = z.object({
  email:        z.string().email(),
  password:     z.string().min(8, 'Password must be at least 8 characters'),
  display_name: z.string().min(1).max(100),
  invite_code:  z.string().min(1, 'An invite code is required to join this community'),
})

export const inviteToCommunitySchema = z.object({
  invited_email:   z.string().email().optional(),
  role:            z.enum(['admin', 'member']).default('member'),
  expires_in_days: z.number().int().min(1).max(365).optional(),
})

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
})

export const updateCommunitySchema = z.object({
  name:         z.string().min(2).max(100).optional(),
  slug:         z.string().min(2).max(50)
                  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, or dashes only')
                  .optional(),
  description:  z.string().max(500).optional(),
  member_limit: z.number().int().min(0).optional(),
})

export const joinCommunitySchema = z.object({
  invite_code: z.string().optional(),
})

export type CreateCommunityInput    = z.infer<typeof createCommunitySchema>
export type CommunityLoginInput     = z.infer<typeof communityLoginSchema>
export type CommunitySignupInput    = z.infer<typeof communitySignupSchema>
export type InviteToCommunityInput  = z.infer<typeof inviteToCommunitySchema>
export type UpdateMemberRoleInput   = z.infer<typeof updateMemberRoleSchema>
export type UpdateCommunityInput    = z.infer<typeof updateCommunitySchema>
export type JoinCommunityInput      = z.infer<typeof joinCommunitySchema>
