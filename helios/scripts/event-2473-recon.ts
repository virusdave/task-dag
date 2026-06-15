// One-off recon: dump state-level marketing event 2473 and its triggers,
// decoding each email trigger's base64 design + html so we can see the
// current content before improving the aesthetics.
//
// Read-only. Probes the state dealer first, falls back to the two site
// dealers if 2473 doesn't resolve there.
//
// Run from helios/:
//   DATABASE_URL=postgres://... npx tsx scripts/event-2473-recon.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'

const EVENT_ID = '2473'
const DEALERS = [210248, 210705, 210249] // state, midtown, bronx

function b64decode(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return ''
  try {
    return Buffer.from(v, 'base64').toString('utf8')
  } catch {
    return '<decode-failed>'
  }
}

async function main(): Promise<void> {
  await withSweedSession(async () => {
    for (const dealerId of DEALERS) {
      try {
        const out = await callSweedRpc<any>(dealerId, 'store.marketing.event.get', {
          id: EVENT_ID,
        })
        console.log(`\n===== FOUND event ${EVENT_ID} on dealer ${dealerId} =====`)
        const { event, triggers } = out
        console.log('--- EVENT ---')
        console.log(JSON.stringify(event, null, 2))
        console.log('\n--- TRIGGERS (summary) ---')
        for (const t of triggers ?? []) {
          console.log(
            `trigger id=${t.id} actionType=${JSON.stringify(t.actionType)} enabled=${t.enabled} header=${JSON.stringify(t.messageHeaderText)} sender=${JSON.stringify(t.sender)}`,
          )
        }
        for (const t of triggers ?? []) {
          if (t.actionType?.id === 3) {
            console.log(`\n===== EMAIL TRIGGER ${t.id} — decoded HTML =====`)
            console.log(b64decode(t.messageText?.html))
            console.log(`\n===== EMAIL TRIGGER ${t.id} — decoded DESIGN (JSON) =====`)
            const design = b64decode(t.messageText?.design)
            console.log(design)
            // also save to /tmp for inspection
            const fs = await import('node:fs')
            fs.writeFileSync(`/tmp/event-2473-trigger-${t.id}.html`, b64decode(t.messageText?.html))
            fs.writeFileSync(`/tmp/event-2473-trigger-${t.id}.design.json`, design)
          }
        }
        return
      } catch (e: unknown) {
        console.log(
          `dealer ${dealerId}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    console.log(`\nEvent ${EVENT_ID} not found on any candidate dealer.`)
  })
}

main().catch((error: unknown) => {
  console.error('[event-2473-recon] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
