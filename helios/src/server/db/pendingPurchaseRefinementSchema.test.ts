import { describe, expect, it } from 'vitest'

import type { Queryable } from './pool.js'
import { pendingPurchaseRefinementSchemaApplied } from './pendingPurchaseRefinementSchema.js'

describe('pendingPurchaseRefinementSchemaApplied', () => {
  it('reports migration 102 unavailable when the complete contract query finds a missing artifact', async () => {
    const db = schemaDb(false)
    await expect(pendingPurchaseRefinementSchemaApplied(db)).resolves.toBe(false)
  })

  it('checks the complete migration contract and accepts it only as one unit', async () => {
    const db = schemaDb(true)
    await expect(pendingPurchaseRefinementSchemaApplied(db)).resolves.toBe(true)
    expect(db.sql).toContain("('pending_purchase_packet_roots', 'created_by_user_id')")
    expect(db.sql).toContain("('pending_purchase_refinement_turns', 'prompt_context_json')")
    expect(db.sql).toContain("pending_purchase_packets_applyable_revision_check")
    expect(db.sql).toContain("pending_purchase_refinement_turns_one_active_idx")
    expect(db.sql).toContain('index_state.indisvalid')
    expect(db.sql).toContain('index_state.indisready')
  })
})

function schemaDb(schemaApplied: boolean): Queryable & { sql: string } {
  return {
    sql: '',
    async query(sql: string) {
      this.sql = sql
      return {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [{ schema_applied: schemaApplied }],
      }
    },
  }
}
