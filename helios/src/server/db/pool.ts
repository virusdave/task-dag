import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

import { readRequiredDatabaseUrl } from '../../shared/config/runtimeEnv.js'

types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export interface Queryable {
  query<TResult extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<TResult>>
}

let cachedPool: Pool | null = null

export function getPool(): Pool {
  if (cachedPool !== null) {
    return cachedPool
  }

  cachedPool = new Pool({
    connectionString: readRequiredDatabaseUrl(),
    max: 10,
  })

  cachedPool.on('error', (error) => {
    console.error('Postgres pool client error:', error)
  })

  return cachedPool
}

export async function closePool(): Promise<void> {
  if (cachedPool !== null) {
    await cachedPool.end()
    cachedPool = null
  }
}

/**
 * A `Queryable` whose every statement runs under a transaction-local
 * `statement_timeout`, on its own dedicated pooled client. Used to bound
 * the cost of operator-supplied aggregation windows (P5 SEO metrics): a
 * deliberately wide window can otherwise tie up a pool connection for
 * seconds (canon §3). `set_config(..., true)` is transaction-scoped so the
 * setting never leaks back to the pool when the client is released. Each
 * call checks out its own client, so callers can still run several queries
 * in parallel (`Promise.all`). A timed-out statement raises pg error code
 * `57014` (`query_canceled`).
 */
export function withStatementTimeout(timeoutMs: number): Queryable {
  return {
    async query<TResult extends QueryResultRow>(queryText: string, values?: unknown[]) {
      return withClient(async (client) => {
        await client.query('begin')
        try {
          await client.query(`select set_config('statement_timeout', $1, true)`, [
            String(Math.max(1, Math.floor(timeoutMs))),
          ])
          const result = await client.query<TResult>(queryText, values)
          await client.query('commit')
          return result
        } catch (error) {
          await client.query('rollback').catch(() => {})
          throw error
        }
      })
    },
  }
}

/** True iff the error is a Postgres statement_timeout cancellation (57014). */
export function isStatementTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '57014'
}

export async function withClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  const removeErrorLogger = attachPoolClientErrorLogger(client, 'withClient')
  try {
    return await run(client)
  } finally {
    removeErrorLogger()
    client.release()
  }
}

export function attachPoolClientErrorLogger(client: PoolClient, context: string): () => void {
  const onError = (error: Error) => {
    console.error(`Postgres client error (${context}):`, error)
  }

  client.on('error', onError)

  return () => {
    client.off('error', onError)
  }
}
