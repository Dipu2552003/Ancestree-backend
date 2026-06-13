import jwt from 'jsonwebtoken'
import { logger } from './logger'

export interface JwtPayload {
  userId:      string
  familyId:    string
  communityId?: string | null
}

const rawSecret = process.env.JWT_SECRET
if (!rawSecret) {
  logger.fatal('JWT_SECRET environment variable is not set')
  process.exit(1)
}
const SECRET = rawSecret

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, SECRET)
  if (typeof decoded !== 'object' || decoded === null || !('userId' in decoded) || !('familyId' in decoded)) {
    throw new Error('Invalid token payload')
  }
  return decoded as JwtPayload
}
