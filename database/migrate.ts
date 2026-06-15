import * as fs from 'fs'
import * as path from 'path'
import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

const migrationsDir = path.join(__dirname, 'migrations')

// Postgres error codes that mean "this object already exists"
const ALREADY_EXISTS = new Set(['42P07', '42701', '42710'])

export async function runMigrations(connectionString: string): Promise<void> {
  // Mirror the pool's TLS setting — managed Postgres needs it, Railway's
  // private network does not (see src/utils/db.ts).
  const ssl = process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : false
  const client = new Client({ connectionString, ssl })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        run_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort()

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations'
    )
    const already = new Set(rows.map(r => r.filename))
    const pending = files.filter(f => !already.has(f))

    if (pending.length === 0) {
      console.log('✓ Migrations up to date')
      return
    }

    console.log(`Running ${pending.length} pending migration(s)…`)

    await client.query('BEGIN')
    try {
      for (const file of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').trim()
        process.stdout.write(`  ${file} … `)

        await client.query('SAVEPOINT pre_migration')
        try {
          await client.query(sql)
          await client.query('RELEASE SAVEPOINT pre_migration')
          console.log('✓')
        } catch (err: any) {
          await client.query('ROLLBACK TO SAVEPOINT pre_migration')
          await client.query('RELEASE SAVEPOINT pre_migration')
          if (ALREADY_EXISTS.has(err.code)) {
            console.log('(already applied, skipped)')
          } else {
            throw err
          }
        }

        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        )
      }
      await client.query('COMMIT')
      console.log('✓ Migrations complete\n')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  } finally {
    await client.end()
  }
}

// Standalone: npx ts-node database/migrate.ts
if (require.main === module) {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL is not set.')
    process.exit(1)
  }
  runMigrations(connectionString)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err)
      process.exit(1)
    })
}
