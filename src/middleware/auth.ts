import { Request, Response, NextFunction } from 'express'
import { verifyToken, JwtPayload } from '../utils/jwt'
import { logger } from '../utils/logger'

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    logger.warn({ method: req.method, path: req.path }, 'auth: missing token')
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }
  const token = header.slice(7)
  try {
    req.user = verifyToken(token)
    next()
  } catch (err) {
    logger.warn({ method: req.method, path: req.path, err }, 'auth: invalid token')
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

/** Like requireAuth but never rejects — sets req.user if a valid token is present,
 *  leaves it undefined otherwise. Use on routes that work with or without a session. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7))
    } catch {
      // token present but invalid — treat as anonymous
    }
  }
  next()
}
