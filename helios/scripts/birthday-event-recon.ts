// One-off recon: dump the current shape of the state-level Sweed
// marketing event 2232 ("Happy Birthday — 5% off") so we know what
// trigger IDs / sender object / cron schedule are already configured
// before we write the email + SMS message bodies.
//
// Read-only; uses the standard helios session-pool flow.
//
// Run:
//   DATABASE_URL=postgres://... \
//   SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   npx tsx scripts/birthday-event-recon.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

const EVENT_ID = '2232'

async function main(): Promise<void> {
  const env = getWorkerEnv()
  const dealerId = env.sweedStateDealerId

  const out = await withSweedSession(async () => {
    return callSweedRpc<unknown>(dealerId, 'store.marketing.event.get', { id: EVENT_ID })
  })

  console.log(JSON.stringify(out, null, 2))
}

main().catch((error: unknown) => {
  console.error('[birthday-event-recon] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
