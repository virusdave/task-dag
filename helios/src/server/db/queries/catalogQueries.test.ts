import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Regression for May 2026 prod 5xx on /catalog/browser:
//
// An earlier refactor sorted the browser query by `cg.updated_at`,
// but the `catalog_groups` table only carries `last_synced_at` and
// `drifted_at`. Every other call site in this file already uses
// `last_synced_at`; the stray `updated_at` in the page query crashed
// the route in prod ("column cg.updated_at does not exist").
//
// We assert the source-file SQL string directly. This is a deliberately
// cheap grammar invariant — it does not require a live DB — and it
// catches the exact regression class that broke prod.
describe('catalogQueries.ts source-level SQL invariants', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'catalogQueries.ts'), 'utf8')

  it('sorts the browser query by an existing catalog_groups column', () => {
    expect(source).toMatch(/order by\s+cg\.last_synced_at\s+desc/i)
  })

  it('never references the non-existent cg.updated_at column', () => {
    expect(source).not.toMatch(/cg\.updated_at/i)
  })
})
