import { buildServer } from './app/buildServer.js'
import { getServerEnv } from './config/env.js'
import { bootstrapParserRegistry } from '../lib/parsekit/node/index.js'
import { getTaskDagSources, initTaskDagMirror, publicTaskDagError } from './taskDagMirror.js'
import { probeTaskDagReader } from './taskDagRepo.js'
import { initAgentPainPointsMirror } from './agentPainPointsMirror.js'
import { initAgentWasteBacklogReader } from './agentWasteBacklogReader.js'

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

// Initial agent-pain-points mirror fetch + arm periodic refresh.
// Loud-but-non-fatal: the agent-waste backlog reports "unavailable"
// (structured 503) rather than crashing if the mirror can't be fetched
// (e.g. the read deploy key is not yet provisioned). This is a read-only
// mirror (of virusdave/agent-pain-points) alongside the automation task-DAG
// mirror; it feeds the agent-waste backlog reader (issue #64 — the
// agent-pain-points migration moved this storage out of top-level).
await initAgentPainPointsMirror({ log: gitFetchLog })

// Install the agent-pain-points-mirror-backed agent-waste backlog reader,
// replacing the default unavailable reader so GET /api/agent-waste/backlog
// returns real pending-review items. Must run AFTER initAgentPainPointsMirror.
// Still 503-degrades (never 500s) while the mirror is unavailable (issue #64).
initAgentWasteBacklogReader()

try {
  await server.listen({ host: '0.0.0.0', port: env.port })
  for (const source of getTaskDagSources().filter((candidate) => candidate.gitDir != null)) {
    try {
      const probe = await probeTaskDagReader(source.repository)
      gitFetchLog.info('task-dag v2 reader ready', { repository: source.repository, taskCount: probe.taskCount })
    } catch (error) {
      gitFetchLog.error('task-dag v2 reader unavailable', {
        repository: source.repository,
        error: publicTaskDagError(error),
      })
    }
  }
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
