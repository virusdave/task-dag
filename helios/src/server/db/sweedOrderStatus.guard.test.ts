import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// ============================================================================
// Static guardrail for the cancelled-order bug FAMILY.
//
// History: the cancelled-order exclusion predicate was hand-copied into many
// query modules guarded only by "keep in sync" comments. They drifted, and
// several customer-facing surfaces (check-ins list, customer details, customer
// map) shipped summing `grand_total_dollars` over `sweed_orders` WITHOUT
// excluding cancelled orders — inflating lifetime spend / order counts. The
// authoritative predicate now lives in src/server/db/sweedOrderStatus.ts.
//
// This test fails the build if any server SQL string aggregates a Sweed
// ORDER-HEADER dollar column (grand_total_dollars / subtotal_dollars — these
// exist only on `sweed_orders`) without, in the same SQL template, ONE of:
//   * a reference to the canonical helper (`nonCancelledOrderSql` /
//     `NON_CANCELLED_ORDER_SQL`), or
//   * an explicit opt-out marker `sweed-cancelled-intentional: <reason>`
//     (for the rare metric that deliberately includes cancelled orders).
// A bare inline `invoiceStatus` literal is NOT an accepted escape hatch:
// header status must flow through the canonical helper (a separate test below
// bans raw header-status literals outside the canonical module).
//
// Header dollar sums are the highest-signal, lowest-false-positive marker of
// "this is a real-money rollup over orders"; the order-count in the same
// lateral/CTE is protected transitively because it lives in the same template.
// ============================================================================

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = join(HERE, '..') // src/server

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      out.push(...collectTsFiles(full))
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.test.ts')) continue
    if (entry === 'sweedOrderStatus.ts') continue // the canonical home
    out.push(full)
  }
  return out
}

/** Extract every backtick-delimited template literal body from source. SQL
 *  here never nests backticks, so a non-greedy match is sufficient. */
function templateLiterals(source: string): string[] {
  const out: string[] = []
  const re = /`([\s\S]*?)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[1]!)
  return out
}

// A header dollar column (these exist only on the sweed_orders header).
const HEADER_DOLLAR_COL = /\b(?:grand_total_dollars|subtotal_dollars)\b/
// Any sum()/avg() aggregate. Broadened beyond `sum(<column>)` so the common
// "project `grand_total_dollars as x`, then `sum(x)`" pattern is also caught.
const DOLLAR_AGGREGATE = /\b(?:sum|avg)\s*\(/i
const TOUCHES_ORDERS = /(?:from|join)\s+sweed_orders\b/i

function hasExclusionOrOptOut(sql: string): boolean {
  return (
    // canonical helper call `nonCancelledOrderSql(` OR the derived
    // `NON_CANCELLED_ORDER_SQL` constant (underscore/case-tolerant). NOTE:
    // a bare inline `invoiceStatus` literal is deliberately NOT accepted —
    // header status must flow through the canonical helper (see the
    // header-literal ban test below).
    /non_?cancelled_?order/i.test(sql) ||
    // explicit, reasoned opt-out for a metric that includes cancelled.
    /sweed-cancelled-intentional/.test(sql)
  )
}

describe('cancelled-order guard: header dollar sums over sweed_orders must exclude cancelled', () => {
  const files = collectTsFiles(SERVER_ROOT)

  it('finds server source to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('no SQL aggregates order-header dollars over sweed_orders without the cancelled guard', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const tpl of templateLiterals(source)) {
        if (!TOUCHES_ORDERS.test(tpl)) continue
        if (!HEADER_DOLLAR_COL.test(tpl)) continue
        if (!DOLLAR_AGGREGATE.test(tpl)) continue
        if (hasExclusionOrOptOut(tpl)) continue
        offenders.push(
          `${relative(SERVER_ROOT, file)}: a SQL template aggregates ` +
            `grand_total_dollars/subtotal_dollars over sweed_orders without ` +
            `nonCancelledOrderSql() or a "sweed-cancelled-intentional:" marker.`,
        )
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no raw header-status read remains outside the canonical module', () => {
    // Header status must be expressed via the canonical helper so the
    // predicate cannot drift. (Line-grain `raw_item->invoiceItemStatus`
    // jsonb-element reads have a different shape and are out of scope here.)
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (/raw_json\s*->\s*'invoiceStatus'/.test(source)) {
        offenders.push(relative(SERVER_ROOT, file))
      }
    }
    expect(
      offenders,
      `raw_json->'invoiceStatus' must not appear in server code; found in:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
