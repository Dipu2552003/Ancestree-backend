import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import dotenv from 'dotenv'
import { logger } from './logger'

dotenv.config()

// Managed Postgres (Neon, Render, Supabase) requires TLS; Railway's private
// network does not. Set DATABASE_SSL=require on hosts that need it.
const ssl = process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : false

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err: Error) => {
  logger.error({ err }, 'unexpected PostgreSQL pool error')
  process.exit(1)
})

// Both Pool and PoolClient expose the same `.query(text, params)` shape.
// runQuery wraps either with the same timing + slow-query logging so a query
// inside a transaction is traced the same way as one outside.
type PgExecutor = Pick<Pool | PoolClient, 'query'>

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  exec: PgExecutor,
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await exec.query(text, params as any)) as QueryResult<T>
  const ms = Date.now() - start
  logger.debug({ sql: text.slice(0, 80), ms, rows: result.rowCount }, 'db query')
  if (ms > 500) logger.warn({ sql: text.slice(0, 120), ms }, 'slow query')
  return result
}

/**
 * Uniform query interface used by repositories. The default runner targets the
 * pool; withTransaction() hands out a tx-scoped runner that funnels every call
 * through a single PoolClient inside a BEGIN/COMMIT envelope.
 */
export interface QueryRunner {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>
}

export const defaultRunner: QueryRunner = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
    runQuery<T>(pool, text, params),
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return defaultRunner.query<T>(text, params)
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
