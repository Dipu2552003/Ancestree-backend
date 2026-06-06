import { Pool, QueryResult, QueryResultRow } from 'pg'
import dotenv from 'dotenv'
import { logger } from './logger'

dotenv.config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected PostgreSQL pool error')
  process.exit(1)
})

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now()
  const result = await pool.query<T>(text, params)
  const ms = Date.now() - start
  logger.debug({ sql: text.slice(0, 80), ms, rows: result.rowCount }, 'db query')
  if (ms > 500) logger.warn({ sql: text.slice(0, 120), ms }, 'slow query')
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
