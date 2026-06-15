import { buildServer } from './app/buildServer.js'
import { getServerEnv } from './config/env.js'
import { bootstrapParserRegistry } from '../lib/parsekit/node/index.js'
import { initTaskDagMirror } from './taskDagMirror.js'

const env = getServerEnv()
const server = await buildServer()

const gitFetchLog = {
  info: (msg: string, meta?: Record<string, unknown>) => server.log.info({ ...(meta ?? {}) }, msg),
  warn: (msg: string, meta?: Record<string, unknown>) => server.log.warn({ ...(meta ?? {}) }, msg),
  error: (msg: string, meta?: Record<string, unknown>) =>
    server.log.error({ ...(meta ?? {}) }, msg),
}

// Initial parser-configs load + arm periodic refresh. Loud-but-non-fatal:
// if the helios-parser-configs repo is unreachable or any config fails
// validation we log and keep serving the legacy parser path.
await bootstrapParserRegistry({ log: gitFetchLog })

// Initial task-DAG mirror fetch + arm periodic refresh. Loud-but-non-fatal:
// the /tasks pages report "task data unavailable" rather than crashing if
// the mirror can't be fetched. The production deploy tarball strips .git,
// so this mirror is the only source of task refs in prod.
await initTaskDagMirror({ log: gitFetchLog })

try {
  await server.listen({ host: '0.0.0.0', port: env.port })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
