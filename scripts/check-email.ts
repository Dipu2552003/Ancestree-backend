// Confirms Resend HTTP email delivery works (no SMTP — Render blocks those ports).
// Usage:
//   npx ts-node scripts/check-email.ts you@x.com  → send a real test email
import dotenv from 'dotenv'
import { sendMail } from '../src/utils/email'

dotenv.config()

const to = process.argv[2]

async function main() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing in .env')
  if (!to) {
    console.log('ℹ  Pass an email address to send a real test message.')
    return
  }
  await sendMail({
    to,
    subject: 'Khandelwal Parivar — email test',
    text: 'If you can read this, Resend HTTP email delivery works.',
    html: '<p>If you can read this, <b>Resend HTTP email delivery works.</b></p>',
  })
  console.log(`📨 Sent to ${to}. Not in inbox? Check spam, and confirm the domain is verified in Resend → Domains.`)
}

main().catch((e) => {
  console.error('❌ Email check failed:', e.message)
  process.exit(1)
})
