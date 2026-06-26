// Zod validation middleware. Replaces the per-route
//   const parsed = schema.safeParse(req.body)
//   if (!parsed.success) { res.status(400).json(...); return }
// boilerplate.
//
// Successful payloads land on `req.validated` (typed via module augmentation
// below) and the global error middleware formats ZodError failures uniformly.
//
//   router.post('/', validate(createPersonSchema), asyncHandler(async (req, res) => {
//     const input = req.validated as CreatePersonInput
//     ...
//   }))

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { ZodSchema } from 'zod'

declare global {
  namespace Express {
    interface Request {
      validated?: unknown
    }
  }
}

export function validate(schema: ZodSchema): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) return next(result.error)
    req.validated = result.data
    next()
  }
}
