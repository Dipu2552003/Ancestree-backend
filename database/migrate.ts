import * as fs from 'fs'
import * as path from 'path'
import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

const migrationsDir = path.join(__dirname, 'migrations')

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL environment variable is not set.')
    console.error('Copy .env.example to .env and fill in your database credentials.')
    process.exit(1)
  }

  const client = new Client({ connectionString })

  try {
    await client.connect()
    console.log('✓ Connected to PostgreSQL\n')
  } catch (err) {
    console.error('ERROR: Could not connect to PostgreSQL:', err)
    process.exit(1)
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('No migration files found.')
    await client.end()
    return
  }

  console.log(`Found ${files.length} migration files. Running inside a transaction...\n`)

  await client.query('BEGIN')

  try {
    for (const file of files) {
      const filePath = path.join(migrationsDir, file)
      const sql = fs.readFileSync(filePath, 'utf8').trim()

      process.stdout.write(`  Running ${file} ... `)
      await client.query(sql)
      console.log('✓')
    }

    await client.query('COMMIT')
    console.log('\n✓ All migrations complete.')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('\nERROR: Migration failed — rolled back all changes.')
    console.error(err)
    await client.end()
    process.exit(1)
  }

  await client.end()
}

migrate()
