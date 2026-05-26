// Set every ENABLED promo action in Sweed campaign 13119
// ("SmokeShopConquest", Bronx dealer 210249) to a recurring
// daily-all-day schedule.
//
// "Recurring daily" in Sweed's promo-action model means
// `cronExpression = "0 0 * * * *"` (every day, every hour — Sweed's
// 6-field "sec min hour dom month dow year" wildcard daily form,
// already used by Veterans Discount / Bundles / 1Off Brands 20% Off
// / Cross-State Demographic). When no startTimeMin/endTimeMin are
// set the promo applies all day.
//
// Per AGENTS.md ("disabled = DEAD, skip non-fatally"), the 3
// "unused probe …" promo actions that are currently `enabled: false`
// are filtered out at the list step and left untouched.
//
// Run:
//   DATABASE_URL=postgres://... \
//   SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   npx tsx scripts/promo-daily-apply.ts

import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'

const DEALER_ID = 210249
const CAMPAIGN_ID = '13119'
const DAILY_CRON = '0 0 * * * *'

interface ActionRow {
  id: string
  name: string
  enabled: boolean
  cronExpression?: string | null
  startTimeMin?: number | null
  endTimeMin?: number | null
}

interface ActionListResponse {
  data?: ActionRow[]
  totalCount?: number
}

async function main(): Promise<void> {
  await withSweedSession(async () => {
    const listed = await callSweedRpc<ActionListResponse>(
      DEALER_ID,
      'store.promo.action.list',
      { campaignId: CAMPAIGN_ID, page: 1, pageSize: 100 },
    )
    const all = listed.data ?? []
    const enabled = all.filter((a) => a.enabled === true)
    const skipped = all.filter((a) => a.enabled === false)
    console.log(`[promo-daily-apply] campaign ${CAMPAIGN_ID}: ${all.length} actions total, ${enabled.length} enabled, ${skipped.length} skipped (disabled)`)
    for (const s of skipped) {
      console.warn(`[promo-daily-apply] SKIP disabled action ${s.id} "${s.name}"`)
    }

    for (const action of enabled) {
      const wasDaily = action.cronExpression === DAILY_CRON
      console.log(
        `[promo-daily-apply] action ${action.id} "${action.name}" current cron=${JSON.stringify(action.cronExpression ?? null)}; setting daily ...`,
      )
      await callSweedRpc<unknown>(DEALER_ID, 'store.promo.action.edit', {
        id: action.id,
        cronExpression: DAILY_CRON,
      })
      console.log(`  done${wasDaily ? ' (no change — already daily)' : ''}`)
    }

    // Verify
    console.log('\n[promo-daily-apply] post-edit verification:')
    const after = await callSweedRpc<ActionListResponse>(
      DEALER_ID,
      'store.promo.action.list',
      { campaignId: CAMPAIGN_ID, page: 1, pageSize: 100 },
    )
    for (const row of after.data ?? []) {
      console.log(
        `  - ${row.id.padStart(5, ' ')} enabled=${row.enabled} cron=${JSON.stringify(row.cronExpression ?? null)} startTimeMin=${row.startTimeMin ?? '-'} endTimeMin=${row.endTimeMin ?? '-'}  "${row.name}"`,
      )
    }
  })
}

main().catch((err: unknown) => {
  console.error('[promo-daily-apply] FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
