// Wraps an async route handler so rejections forward to the global error
// middleware. Removes the per-route `try { ... } catch (err: any) { res.status(...) }`
// boilerplate.
//
//   router.get('/:id', asyncHandler(async (req, res) => {
//     const item = await getItem(req.params.id)
//     res.json(item)
//   }))

import type { Request, Response, NextFunction, RequestHandler } from 'express'

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
