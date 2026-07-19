import nodemailer from 'nodemailer'
import { logger } from './logger'

// One shared SMTP transport (Brevo). Built lazily so the app still boots when
// SMTP isn't configured — in that case sendMail() logs instead of sending.
let mailer: nodemailer.Transporter | null = null
function getMailer(): nodemailer.Transporter | null {
  if (mailer) return mailer
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: false, // Brevo uses STARTTLS on 587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  return mailer
}

type Mail = { to: string; subject: string; text: string; html: string }

/** Sends an email. If SMTP is unconfigured, logs the payload and returns. */
export async function sendMail({ to, subject, text, html }: Mail): Promise<void> {
  const transport = getMailer()
  if (!transport) {
    logger.warn({ to, subject }, 'SMTP not configured — skipping send')
    // eslint-disable-next-line no-console
    console.log(`\n[email:${subject}] → ${to}\n${text}\n`)
    return
  }
  await transport.sendMail({
    from: process.env.EMAIL_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  })
  logger.info({ to, subject }, 'email sent')
}

// Shared brand wrapper so all our emails look consistent.
export function brandEmail(heading: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6;color:#3f2d1e">
            <h2 style="color:#7A1315;margin:0 0 12px">${heading}</h2>
            ${bodyHtml}
          </div>`
}
