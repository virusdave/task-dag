import { buildServer } from './app/buildServer.js'
import { getServerEnv } from './config/env.js'
import { bootstrapParserRegistry } from '../lib/parsekit/node/index.js'

const env = getServerEnv()
const server = await buildServer()

// Initial parser-configs load + arm periodic refresh. Loud-but-non-fatal:
// if the helios-parser-configs repo is unreachable or any config fails
// validation we log and keep serving the legacy parser path.
await bootstrapParserRegistry({
  log: {
    info: (msg, meta) => server.log.info({ ...(meta ?? {}) }, msg),
    warn: (msg, meta) => server.log.warn({ ...(meta ?? {}) }, msg),
    error: (msg, meta) => server.log.error({ ...(meta ?? {}) }, msg),
  },
})

try {
  await server.listen({ host: '0.0.0.0', port: env.port })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
