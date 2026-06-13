// Tenant-scope middleware.
//
// Reads the communityId from the already-verified JWT (set by requireAuth)
// and stamps req.scope so any downstream handler can branch on
// public vs community without repeating the same JWT inspection.
//
// Wire it AFTER requireAuth on routers that need scope awareness.
// For public routes (no JWT), req.scope defaults to { type: 'public', communityId: null }.

import type { Request, Response, NextFunction } from 'express'

export interface TenantScope {
  type:        'public' | 'community'
  communityId: string | null
}

declare global {
  namespace Express {
    interface Request {
      scope: TenantScope
    }
  }
}

export function resolveScope(req: Request, _res: Response, next: NextFunction): void {
  const communityId = (req as { user?: { communityId?: string | null } }).user?.communityId ?? null
  req.scope = communityId
    ? { type: 'community', communityId }
    : { type: 'public', communityId: null }
  next()
}
