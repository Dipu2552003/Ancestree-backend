import { logger } from './logger'

// Resend transactional email over HTTP (port 443). We deliberately do NOT use
// SMTP: Render blocks outbound SMTP ports (25/465/587), so nodemailer connects
// hang with ETIMEDOUT. The HTTP API works everywhere. Needs RESEND_API_KEY and
// a sender on a domain verified in Resend (EMAIL_FROM).

type Mail = { to: string; subject: string; text: string; html: string }

// Resend's `from` accepts "Name <email@domain>" or "email@domain" directly,
// which is exactly the EMAIL_FROM format — so we pass it through as-is.
function getSender(): string | null {
  const raw = process.env.EMAIL_FROM ?? process.env.SMTP_USER
  return raw ? raw.trim() : null
}

/** Sends an email via Resend's HTTP API. If unconfigured, logs and returns. */
export async function sendMail({ to, subject, text, html }: Mail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const from = getSender()
  if (!apiKey || !from) {
    logger.warn({ to, subject }, 'RESEND_API_KEY/EMAIL_FROM not configured — skipping send')
    // eslint-disable-next-line no-console
    console.log(`\n[email:${subject}] → ${to}\n${text}\n`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Resend send failed ${res.status}: ${detail}`)
  }
  logger.info({ to, subject }, 'email sent')
}

// Shared brand wrapper so all our emails look consistent.
export function brandEmail(heading: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6;color:#3f2d1e">
            <h2 style="color:#7A1315;margin:0 0 12px">${heading}</h2>
            ${bodyHtml}
          </div>`
}
