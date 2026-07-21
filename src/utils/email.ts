import { logger } from './logger'

// Brevo transactional email over HTTP (port 443). We deliberately do NOT use
// SMTP: Render blocks outbound SMTP ports (25/465/587), so nodemailer connects
// hang with ETIMEDOUT. The HTTP API works everywhere. Needs BREVO_API_KEY.

type Mail = { to: string; subject: string; text: string; html: string }

// Parse EMAIL_FROM ("Name <email@x>" or "email@x") into Brevo's sender shape.
function parseSender(): { email: string; name?: string } | null {
  const raw = process.env.EMAIL_FROM ?? process.env.SMTP_USER
  if (!raw) return null
  const m = raw.match(/^\s*(.*?)\s*<(.+)>\s*$/)
  return m ? { name: m[1] || undefined, email: m[2] } : { email: raw.trim() }
}

/** Sends an email via Brevo's HTTP API. If unconfigured, logs and returns. */
export async function sendMail({ to, subject, text, html }: Mail): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY
  const sender = parseSender()
  if (!apiKey || !sender) {
    logger.warn({ to, subject }, 'BREVO_API_KEY/sender not configured — skipping send')
    // eslint-disable-next-line no-console
    console.log(`\n[email:${subject}] → ${to}\n${text}\n`)
    return
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Brevo send failed ${res.status}: ${detail}`)
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
