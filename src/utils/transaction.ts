// Declarative transaction wrapper. Replaces the manual
//   const client = await pool.connect()
//   try { await client.query('BEGIN'); ...; await client.query('COMMIT') }
//   catch (err) { await client.query('ROLLBACK'); throw err }
//   finally { client.release() }
// pattern that used to live inline in every multi-statement service path.
//
// Repos accept an optional QueryRunner; the runner handed to the callback
// targets the tx-scoped PoolClient, so any repo called inside the callback
// participates in the transaction. Anything called *outside* (or without an
// explicit runner) goes through the pool.

import pool, { runQuery, type QueryRunner } from './db'

export async function withTransaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx: QueryRunner = {
      query: (text, params) => runQuery(client, text, params),
    }
    const result = await fn(tx)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
