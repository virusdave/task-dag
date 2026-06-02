// Probe Sweed completed POs to answer the design unknowns for the
// new Catalog → Purchase Sell-Through page family:
//
//   1. Does `store.purchase.order.get` return per-line `inventoryItemId`
//      and/or Metrc tag / `externalTrackCode` for completed POs?
//   2. Is `wholesalePrice` total-line or per-unit?
//   3. Is there a payment-due-date field on the PO header?
//   4. Are PO ids dealer-scoped (yes — they live behind a dealer pin)
//      or globally unique?
//
// Pulls a handful of completed (non-pending) POs for one site, dumps
// the redacted header + first 3 positions, and prints a summary of
// whether the package-bridge fields are present.

import { withSweedSession } from '../src/worker/sweed/session.js'
import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../src/shared/contracts/domain/pendingPurchases.js'

const MAX_ORDERS = 5

interface ListResp {
  data: Array<{
    id: number | string
    orderStatusId?: number
    deliveryDate?: string
  }>
  totalCount?: number
}

interface PoDetail {
  id: number | string
  deliveryDate?: string | null
  positions: Array<Record<string, unknown>>
  [k: string]: unknown
}

function pickInterestingHeaderKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter(
    (k) =>
      /payment|due|paid|delivery|status|distributor|external|total|amount/i.test(k) &&
      typeof obj[k] !== 'object',
  )
}

function summarisePosition(pos: Record<string, unknown>): {
  topKeys: string[]
  hasMetrcTagOrInventoryItem: boolean
  candidatePackageFields: Record<string, unknown>
} {
  const topKeys = Object.keys(pos)
  const candidates: Record<string, unknown> = {}
  for (const k of topKeys) {
    if (/metrc|external|tag|inventory|package|track|batch|trackCode/i.test(k)) {
      candidates[k] = pos[k]
    }
  }
  // Look one level deeper too — sweed nests integration data + product.
  for (const k of topKeys) {
    const v = pos[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of Object.keys(v as object)) {
        if (/metrc|external|tag|inventory|package|track|batch|trackCode/i.test(sub)) {
          candidates[`${k}.${sub}`] = (v as Record<string, unknown>)[sub]
        }
      }
    }
  }
  return {
    topKeys,
    hasMetrcTagOrInventoryItem: Object.keys(candidates).length > 0,
    candidatePackageFields: candidates,
  }
}

async function probeDealer(dealerId: number, dealerName: string): Promise<void> {
  console.log(`\n=== Dealer ${dealerId} (${dealerName}) ===`)

  // Pull a recent window of completed POs. orderStatusId values we
  // care about are not 2 (pending) — exact taxonomy unknown, so just
  // list a wide window and we'll filter on the response.
  const fromDate = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const toDate = new Date().toISOString().slice(0, 10)
  const listResp = await callSweedRpc<ListResp>(dealerId, 'store.purchase.order.list', {
    fromDate,
    toDate,
    page: 1,
    pageSize: 50,
  })
  const total = listResp.totalCount ?? listResp.data.length
  console.log(`  list returned ${listResp.data.length} of ${total} POs (window ${fromDate}..${toDate})`)

  const interesting = listResp.data.filter((row) => (row.orderStatusId ?? 0) !== 2).slice(0, MAX_ORDERS)
  if (interesting.length === 0) {
    console.log('  no non-pending POs in this window — falling back to whatever list returned')
    interesting.push(...listResp.data.slice(0, MAX_ORDERS))
  }

  let positionsTotal = 0
  let positionsWithPackageBridge = 0

  for (const stub of interesting) {
    const detail = await callSweedRpc<PoDetail>(dealerId, 'store.purchase.order.get', {
      id: stub.id,
    })
    const headerKeys = Object.keys(detail)
    const interestingHeader = pickInterestingHeaderKeys(detail as Record<string, unknown>)
    const positions = (detail.positions ?? []) as Array<Record<string, unknown>>
    console.log(`\n  --- PO id=${detail.id} ---`)
    console.log(`    header keys count: ${headerKeys.length}`)
    console.log(`    interesting scalar header keys: ${JSON.stringify(interestingHeader)}`)
    // Print a curated header view.
    const headerSummary: Record<string, unknown> = {}
    for (const k of [
      'id',
      'name',
      'externalOrderId',
      'deliveryDate',
      'paymentDueDate',
      'expectedPaymentDate',
      'paymentTerms',
      'paymentDueAt',
      'createDate',
      'updateDate',
      'createTime',
    ]) {
      if (k in detail) headerSummary[k] = (detail as Record<string, unknown>)[k]
    }
    const dist = (detail as Record<string, unknown>).distributor as
      | Record<string, unknown>
      | undefined
    if (dist) {
      headerSummary['distributor.id'] = dist.id
      headerSummary['distributor.name'] = dist.name
    }
    const orderStatus = (detail as Record<string, unknown>).orderStatus as
      | Record<string, unknown>
      | undefined
    if (orderStatus) headerSummary['orderStatus.name'] = orderStatus.name
    const financialStatus = (detail as Record<string, unknown>).financialStatus as
      | Record<string, unknown>
      | undefined
    if (financialStatus) headerSummary['financialStatus.name'] = financialStatus.name
    console.log('    header curated:', JSON.stringify(headerSummary))

    console.log(`    position count: ${positions.length}`)
    if (positions.length > 0) {
      const sample = summarisePosition(positions[0]!)
      console.log(`    position[0] top-level keys: ${JSON.stringify(sample.topKeys)}`)
      console.log(
        `    position[0] candidate package-bridge fields: ${JSON.stringify(sample.candidatePackageFields)}`,
      )
      // Also print the full first position payload pretty-printed
      // for human eyeballing (one is enough — we don't want a 5000-line
      // log).
      console.log('    position[0] full JSON:')
      console.log(
        JSON.stringify(positions[0], null, 2)
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n'),
      )
    }
    for (const p of positions) {
      positionsTotal += 1
      if (summarisePosition(p).hasMetrcTagOrInventoryItem) positionsWithPackageBridge += 1
    }
  }

  console.log(
    `\n  SUMMARY: ${positionsWithPackageBridge}/${positionsTotal} positions across ${interesting.length} POs expose a Metrc/inventory/track-code field`,
  )
}

async function main(): Promise<void> {
  await withSweedSession(async () => {
    for (const dealer of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
      try {
        await probeDealer(dealer.dealerId, dealer.dealerName)
      } catch (err) {
        console.error(`[probe] dealer ${dealer.dealerId} failed:`, err)
      }
    }
  })
}

main().catch((e) => {
  console.error('[probe-sweed-purchase-orders] FAIL:', e)
  process.exit(1)
})
