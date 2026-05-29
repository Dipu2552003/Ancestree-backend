import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

async function reset(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL is not set.')
    process.exit(1)
  }

  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(`
      TRUNCATE TABLE
        audit_log,
        merge_records,
        family_members,
        relationships,
        persons,
        families,
        users
      RESTART IDENTITY CASCADE
    `)
    console.log('✓ All user data cleared. schema_migrations preserved.')
  } finally {
    await client.end()
  }
}

reset().catch(err => {
  console.error('Reset failed:', err)
  process.exit(1)
})
