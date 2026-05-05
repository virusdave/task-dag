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
