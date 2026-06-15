import rateLimit from 'express-rate-limit'

// Rate limiting for unauthenticated auth endpoints. These are the only routes an
// attacker can hit without a valid token, so they're the brute-force surface.
//
// The limiter keeps a counter per client key (default: IP address) in memory.
// Each request increments the counter; once it passes `limit` within `windowMs`,
// further requests get 429 until the window rolls over. The window is a sliding
// fixed window per key — the first request of a key starts its clock.

// Tight cap for credential-guessing targets: login, forgot-password,
// reset-password. 10 tries / 15 min / IP is invisible to real users but stops
// password spraying and reset-token guessing.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,                // max requests per IP per window
  standardHeaders: 'draft-7', // send RateLimit-* headers so clients can back off
  legacyHeaders: false,       // drop the old X-RateLimit-* headers
  message: { error: 'Too many attempts. Please try again later.', code: 'rate_limited' },
})

// Looser cap for account creation / existence checks — still bounded so a bot
// can't mass-create accounts or enumerate emails, but roomier than login.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20,                // max new-account / check-email calls per IP per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'rate_limited' },
})
