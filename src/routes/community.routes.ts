import { Router, type Request, type Response } from 'express'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  createCommunitySchema, communityLoginSchema, communitySignupSchema,
  sendSignupCodeSchema, verifySignupCodeSchema,
  sendLoginOtpSchema, verifyLoginOtpSchema,
  inviteToCommunitySchema, updateMemberRoleSchema,
  updateCommunitySchema, joinCommunitySchema,
  type CreateCommunityInput, type CommunityLoginInput, type CommunitySignupInput,
  type SendSignupCodeInput, type VerifySignupCodeInput,
  type SendLoginOtpInput, type VerifyLoginOtpInput,
  type InviteToCommunityInput, type UpdateMemberRoleInput,
  type UpdateCommunityInput, type JoinCommunityInput,
} from '../schemas/community.schema'
import {
  createCommunity, getCommunity, getFieldConfig, updateFieldConfig, replaceFieldOptions,
  updateCommunity, deleteCommunity,
  communityLogin, communitySignup, sendSignupCode, peekSignupCode, joinCommunity, leaveCommunity,
  sendLoginOtp, loginWithOtp,
  inviteToCommunity, getCommunityMembers, updateMemberRole, removeMember,
  listCommunityFamilies, listCommunities, getJoinCode, resetJoinCode,
  getMyCommunityRole, getCommunityStats, getCommunityHealth,
} from '../services/community.service'
import { listCommunityMerges, forceMerge } from '../services/merge'
import { searchPersons, filterCommunityPersons } from '../services/search.service'
import { authLimiter } from '../middleware/rateLimit'
import { query } from '../utils/db'

const router = Router()

// ── Public community listing ──────────────────────────────────────────────────

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const result = await listCommunities()
  res.json(result)
}))

// ── Platform-admin only: create / delete community ────────────────────────────

router.post('/', validate(createCommunitySchema), asyncHandler(async (req: Request, res: Response) => {
  const key = req.headers['x-platform-key']
  if (!key || key !== process.env.PLATFORM_ADMIN_KEY) {
    res.status(401).json({ error: 'Invalid platform admin key. Set PLATFORM_ADMIN_KEY in backend .env and enter the same value here.' })
    return
  }
  const result = await createCommunity(req.validated as CreateCommunityInput)
  res.status(201).json(result)
}))

router.delete('/:slug', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const key = req.headers['x-platform-key']
  if (!key || key !== process.env.PLATFORM_ADMIN_KEY) {
    res.status(401).json({ error: 'Invalid platform admin key. Set PLATFORM_ADMIN_KEY in backend .env and enter the same value here.' })
    return
  }
  const result = await deleteCommunity(req.params['slug'] as string, req.user?.userId ?? null)
  res.json(result)
}))

// ── Public info ───────────────────────────────────────────────────────────────

router.get('/:slug', asyncHandler(async (req: Request, res: Response) => {
  const result = await getCommunity(req.params['slug'] as string)
  res.json(result)
}))

// ── Invite validation (public — no auth needed) ───────────────────────────────
// Frontend fetches this before rendering the signup form so it can pre-fill
// the community name and lock the invite_code field.

router.get('/:slug/invite/:code', asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params['slug'] as string
  const code = req.params['code'] as string

  // Try targeted single-use invite first.
  const { rows: [invite] } = await query<{
    community_name: string; community_slug: string
    role: string; invited_email: string | null
  }>(
    `SELECT c.name AS community_name, c.slug AS community_slug,
            ci.role, ci.invited_email
     FROM   community_invites ci
     JOIN   communities c ON c.id = ci.community_id
     WHERE  ci.invite_code = $1 AND c.slug = $2
       AND  ci.used_by IS NULL
       AND  (ci.expires_at IS NULL OR ci.expires_at > NOW())`,
    [code, slug],
  )
  if (invite) {
    res.json(invite)
    return
  }

  // Fall back to the community's permanent join_code.
  const { rows: [joinMatch] } = await query<{ name: string; slug: string }>(
    `SELECT name, slug FROM communities WHERE slug = $1 AND join_code = $2`,
    [slug, code],
  )
  if (joinMatch) {
    res.json({ community_name: joinMatch.name, community_slug: joinMatch.slug, role: 'member', invited_email: null })
    return
  }

  res.status(404).json({ error: 'Invalid or expired invite link' })
}))

// ── Community-scoped auth ─────────────────────────────────────────────────────

router.post('/:slug/login', authLimiter, validate(communityLoginSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await communityLogin(req.params['slug'] as string, req.validated as CommunityLoginInput)
  res.json(result)
}))

// Login via OTP — step 1: email a 6-digit login code (valid 10 min). Always
// responds 200 to avoid leaking which emails are registered.
router.post('/:slug/login/send-otp', authLimiter, validate(sendLoginOtpSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.validated as SendLoginOtpInput
  const result = await sendLoginOtp(req.params['slug'] as string, email)
  res.json(result)
}))

// Login via OTP — step 2: exchange the code for a session ({ token, user }).
router.post('/:slug/login/verify-otp', authLimiter, validate(verifyLoginOtpSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = req.validated as VerifyLoginOtpInput
  const result = await loginWithOtp(req.params['slug'] as string, email, code)
  res.json(result)
}))

// Step 1 of signup: email a 6-digit verification code (valid 1 hour).
router.post('/:slug/signup/send-code', validate(sendSignupCodeSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, invite_code } = req.validated as SendSignupCodeInput
  const result = await sendSignupCode(req.params['slug'] as string, email, invite_code)
  res.json(result)
}))

// Step 1b of signup: confirm the emailed code before showing later steps.
// Does not consume the code — communitySignup consumes it at the final submit.
router.post('/:slug/signup/verify-code', validate(verifySignupCodeSchema), asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = req.validated as VerifySignupCodeInput
  const result = await peekSignupCode(email, code)
  res.json(result)
}))

// Step 2 of signup: create the account (requires the emailed code).
router.post('/:slug/signup', validate(communitySignupSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await communitySignup(req.params['slug'] as string, req.validated as CommunitySignupInput)
  res.status(201).json(result)
}))

// An already-authenticated platform user joins an existing community.
// Requires a valid invite code in the body.
router.post('/:slug/join', requireAuth, validate(joinCommunitySchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await joinCommunity(
    req.params['slug'] as string,
    req.user.userId,
    req.validated as JoinCommunityInput,
  )
  res.json(result)
}))

// ── Community settings (admin only) ──────────────────────────────────────────

router.patch('/:slug', requireAuth, validate(updateCommunitySchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await updateCommunity(
    req.params['slug'] as string,
    req.validated as UpdateCommunityInput,
    req.user.userId,
  )
  res.json(result)
}))

// ── Community-scoped search (auth required) ───────────────────────────────────
// Searches within the community only, excluding the requester's own family.

router.get('/:slug/search', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const community = await getCommunity(req.params['slug'] as string)
  const results = await searchPersons(q, req.user.familyId, 'external', community.id)
  res.json(results)
}))

// ── Field config: enum option lists (gotra/village) + field rules ────────────
// Public read — reference data used by the Parivar filters and node editor.
router.get('/:slug/field-config', asyncHandler(async (req: Request, res: Response) => {
  const result = await getFieldConfig(req.params['slug'] as string)
  res.json(result)
}))

// Admin write — set which fields show and how (settings.fields).
router.put('/:slug/field-config', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const fields = (req.body?.fields ?? {}) as Record<string, unknown>
  const result = await updateFieldConfig(req.params['slug'] as string, req.user.userId, fields)
  res.json(result)
}))

// Admin write — replace the dropdown values for one enum field.
router.put('/:slug/field-options/:key', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const options = Array.isArray(req.body?.options) ? req.body.options : []
  const result = await replaceFieldOptions(
    req.params['slug'] as string, req.user.userId, req.params['key'] as string, options,
  )
  res.json(result)
}))

// ── Community-wide person directory with filters ("Apna Parivar") ────────────

router.get('/:slug/persons', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const community = await getCommunity(req.params['slug'] as string)
  const str = (k: string) => {
    const v = req.query[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const num = (k: string) => {
    const v = Number(req.query[k])
    return typeof req.query[k] === 'string' && Number.isFinite(v) ? v : undefined
  }
  const results = await filterCommunityPersons(community.id, {
    q: str('q'), gender: str('gender'), gotra: str('gotra'),
    village: str('village'), city: str('city'),
    age_min: num('age_min'), age_max: num('age_max'),
    marital: str('marital'), education: str('education'), occupation: str('occupation'),
  })
  res.json(results)
}))

// ── Member management ─────────────────────────────────────────────────────────

router.get('/:slug/members', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getCommunityMembers(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

router.post('/:slug/invite', requireAuth, validate(inviteToCommunitySchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await inviteToCommunity(
    req.params['slug'] as string,
    req.validated as InviteToCommunityInput,
    req.user.userId,
  )
  res.status(201).json(result)
}))

router.put('/:slug/members/:uid', requireAuth, validate(updateMemberRoleSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await updateMemberRole(
    req.params['slug'] as string,
    req.params['uid'] as string,
    req.validated as UpdateMemberRoleInput,
    req.user.userId,
  )
  res.json(result)
}))

router.delete('/:slug/members/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await leaveCommunity(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

router.delete('/:slug/members/:uid', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await removeMember(
    req.params['slug'] as string,
    req.params['uid'] as string,
    req.user.userId,
  )
  res.json(result)
}))

// ── Admin views ───────────────────────────────────────────────────────────────

router.get('/:slug/join-code', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getJoinCode(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

router.post('/:slug/join-code/reset', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await resetJoinCode(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

router.get('/:slug/families', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await listCommunityFamilies(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

// Admin data-health: 1:1 ownership issues + whether the constraint is live.
router.get('/:slug/health', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getCommunityHealth(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

// ── Requester's own membership (role discovery for the UI) ────────────────────

router.get('/:slug/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getMyCommunityRole(req.params['slug'] as string, req.user.userId)
  res.json(result)
}))

// ── Community-wide member total (all trees combined) ──────────────────────────

router.get('/:slug/stats', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const result = await getCommunityStats(req.params['slug'] as string)
  res.json(result)
}))

// ── Owner-only: community-wide merge management ───────────────────────────────

router.get('/:slug/merges', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const merges = await listCommunityMerges(req.params['slug'] as string, req.user.userId, status)
  res.json({ merges })
}))

router.post('/:slug/merges/force', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { merged_person_id, canonical_person_id, keep_data } = req.body ?? {}
  const keepData = keep_data === 'merged' ? 'merged' as const : 'canonical' as const
  const result = await forceMerge(
    req.params['slug'] as string,
    req.user.userId,
    merged_person_id,
    canonical_person_id,
    keepData,
  )
  res.status(201).json(result)
}))

export default router
