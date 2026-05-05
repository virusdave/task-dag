import type { PoolClient } from 'pg'

import { withClient } from './pool.js'

export async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query('begin')
    try {
      const result = await run(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  })
}
