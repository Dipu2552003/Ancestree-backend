import { Router, type Request, type Response } from 'express'
import { requireAuth, optionalAuth } from '../middleware/auth'
import { asyncHandler } from '../middleware/asyncHandler'
import { validate } from '../middleware/validate'
import {
  createCommunitySchema, communityLoginSchema, communitySignupSchema,
  inviteToCommunitySchema, updateMemberRoleSchema,
  updateCommunitySchema, joinCommunitySchema,
  type CreateCommunityInput, type CommunityLoginInput, type CommunitySignupInput,
  type InviteToCommunityInput, type UpdateMemberRoleInput,
  type UpdateCommunityInput, type JoinCommunityInput,
} from '../schemas/community.schema'
import {
  createCommunity, getCommunity, updateCommunity, deleteCommunity,
  communityLogin, communitySignup, joinCommunity, leaveCommunity,
  inviteToCommunity, getCommunityMembers, updateMemberRole, removeMember,
  listCommunityFamilies, listCommunities, getJoinCode, resetJoinCode,
} from '../services/community.service'
import { searchPersons } from '../services/search.service'
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

router.post('/:slug/login', validate(communityLoginSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await communityLogin(req.params['slug'] as string, req.validated as CommunityLoginInput)
  res.json(result)
}))

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

export default router
