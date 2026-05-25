import { Pool, QueryResult, QueryResultRow } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err)
  process.exit(1)
})

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now()
  const result = await pool.query<T>(text, params)
  if (process.env.NODE_ENV === 'development') {
    console.log(`[db] ${text.slice(0, 80)} — ${Date.now() - start}ms`)
  }
  return result
}

export async function testConnection(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}

export default pool
