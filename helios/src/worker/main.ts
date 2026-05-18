import { bootstrapParserRegistry } from '../lib/parsekit/node/index.js'
import { runWorkerLoop } from './runtime/workerLoop.js'

// Initial parser-configs load + arm periodic refresh. Loud-but-non-fatal:
// if the helios-parser-configs repo is unreachable or any config fails
// validation we log and keep running with the legacy parser path.
await bootstrapParserRegistry()

await runWorkerLoop()
