// Domain-shaped errors thrown by services and caught by the global error
// middleware. Services should throw an AppError (via the helpers below) and
// route handlers should leave them alone — the asyncHandler wrapper forwards
// them to the global error formatter.
//
// Status code reflects the HTTP response. The optional `code` is a short
// machine-readable tag the frontend can use to distinguish kinds of errors
// at the same status (e.g. "claimed_node" vs "self_node" both 403).

export class AppError extends Error {
  status: number
  code:   string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
  }
}

export const badRequest    = (message: string, code?: string) => new AppError(400, message, code)
export const unauthorized  = (message: string, code?: string) => new AppError(401, message, code)
export const forbidden     = (message: string, code?: string) => new AppError(403, message, code)
export const notFound      = (message: string, code?: string) => new AppError(404, message, code)
export const conflict      = (message: string, code?: string) => new AppError(409, message, code)
export const serverError   = (message: string, code?: string) => new AppError(500, message, code)

// Narrow type-guard for the global error handler.
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}
