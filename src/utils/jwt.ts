import jwt from 'jsonwebtoken'

export interface JwtPayload {
  userId: string
  familyId: string
}

const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production'

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload
}
