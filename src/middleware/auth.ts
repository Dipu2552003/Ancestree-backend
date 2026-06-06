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
