// Recon: list nearby site-level marketing events and grep their email
// trigger HTML for the Freshly Baked logo + hero imagery so we can
// crib them into the state-level birthday event (2232).
//
// Strategy: walk through Midtown (210705) and Bronx (210249) events,
// fetch the email trigger content for each, and print any image URLs
// found in either the rendered HTML or the unlayer design JSON. The
// operator can then point birthday-event-apply.ts at the best-looking
// image set.

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'

const DEALERS: Array<{ id: number; label: string }> = [
  { id: 210705, label: 'midtown' },
  { id: 210249, label: 'bronx' },
  { id: 210248, label: 'state' },
]

interface EventListRow {
  id: string | number
  name?: string | null
  enabled?: boolean | null
}

interface EventListResponse {
  data?: EventListRow[]
  totalCount?: number | null
}

interface TriggerContent {
  id: string | number
  actionType?: { id: number; name?: string }
  enabled?: boolean
  messageText?: { design?: string; html?: string }
  approvedImage?: { id?: string; imageUrl?: string }
  imageUrl?: string | null
}

interface EventGetResponse {
  event?: { id: string | number; name?: string; enabled?: boolean }
  triggers?: TriggerContent[]
}

function decode(b64: string | undefined): string {
  if (!b64) return ''
  try {
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function extractImageUrls(text: string): string[] {
  const urls = new Set<string>()
  // Match http(s) image URLs found in HTML attrs or JSON values.
  const re = /https?:\/\/[^\s"'<>)]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi
  for (const m of text.matchAll(re)) urls.add(m[0])
  return [...urls]
}

async function main(): Promise<void> {
  await withSweedSession(async () => {
    for (const dealer of DEALERS) {
      console.log(`\n=== dealer ${dealer.id} (${dealer.label}) ===`)
      let listed: EventListResponse
      try {
        listed = await callSweedRpc<EventListResponse>(dealer.id, 'store.marketing.event.list', {
          page: 1,
          pageSize: 50,
        })
      } catch (err) {
        console.warn(`  event.list failed: ${err instanceof Error ? err.message : err}`)
        continue
      }
      const rows = listed.data ?? []
      console.log(`  events: ${rows.length} (totalCount=${listed.totalCount ?? '?'})`)

      for (const row of rows) {
        let full: EventGetResponse
        try {
          full = await callSweedRpc<EventGetResponse>(dealer.id, 'store.marketing.event.get', {
            id: String(row.id),
          })
        } catch (err) {
          console.warn(`    event ${row.id} (${row.name ?? ''}) get failed: ${err instanceof Error ? err.message : err}`)
          continue
        }
        const triggers = full.triggers ?? []
        const emailTrigger = triggers.find((t) => t.actionType?.id === 3)
        const smsTrigger = triggers.find((t) => t.actionType?.id === 5)
        const imageUrls = new Set<string>()
        if (emailTrigger) {
          extractImageUrls(decode(emailTrigger.messageText?.html)).forEach((u) => imageUrls.add(u))
          extractImageUrls(decode(emailTrigger.messageText?.design)).forEach((u) => imageUrls.add(u))
        }
        if (smsTrigger?.approvedImage?.imageUrl) imageUrls.add(smsTrigger.approvedImage.imageUrl)
        if (smsTrigger?.imageUrl) imageUrls.add(smsTrigger.imageUrl)
        if (imageUrls.size === 0) continue
        console.log(`  - event ${row.id} "${row.name ?? ''}" enabled=${row.enabled ?? '?'}`)
        for (const u of imageUrls) console.log(`      img: ${u}`)
      }
    }
  })
}

main().catch((err: unknown) => {
  console.error('[birthday-imagery-recon] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
