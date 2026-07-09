import { describe, expect, it } from 'vitest'

import type { Queryable } from '../pool.js'
import {
  assertBaseRowsMatchSnapshot,
  assertPendingPurchasePacketApplyable,
  hashJsonForPendingPurchaseRefinement,
  PendingPurchaseRefinementConflictError,
} from './pendingPurchaseRefinementQueries.js'

describe('assertBaseRowsMatchSnapshot', () => {
  const row = {
    lineageRevisionNumber: 1,
    rowId: 10,
    rowLineageId: 'pprline_10',
    rowSnapshotSha256: 'a'.repeat(64),
    version: 3,
  }

  it('accepts matching row lineage/version refs', () => {
    expect(() => assertBaseRowsMatchSnapshot([row], [row])).not.toThrow()
  })

  it('rejects stale row versions', () => {
    expect(() => assertBaseRowsMatchSnapshot([row], [{ ...row, version: 2 }])).toThrow(
      PendingPurchaseRefinementConflictError,
    )
  })

  it('rejects lineage drift even when row id is unchanged', () => {
    expect(() => assertBaseRowsMatchSnapshot([row], [{ ...row, rowLineageId: 'pprline_other' }])).toThrow(
      PendingPurchaseRefinementConflictError,
    )
  })
})

describe('hashJsonForPendingPurchaseRefinement', () => {
  it('is deterministic for object key ordering', () => {
    const left = hashJsonForPendingPurchaseRefinement({ b: 2, a: { d: 4, c: 3 } })
    const right = hashJsonForPendingPurchaseRefinement({ a: { c: 3, d: 4 }, b: 2 })
    expect(left).toBe(right)
  })
})

describe('assertPendingPurchasePacketApplyable', () => {
  it('allows legacy unrooted packets', async () => {
    await expect(assertPendingPurchasePacketApplyable(fakeGateDb({ packet_root_id: null }), 123)).resolves.toBeUndefined()
  })

  it('allows apply before the refinement migration exists', async () => {
    await expect(assertPendingPurchasePacketApplyable(fakeGateDb({ packet_root_id: 1 }, false), 123)).resolves.toBeUndefined()
  })

  it('allows the current applyable revision', async () => {
    await expect(
      assertPendingPurchasePacketApplyable(
        fakeGateDb({
          current_packet_id: 123,
          is_applyable: true,
          packet_root_id: 1,
          revision_status: 'current',
        }),
        123,
      ),
    ).resolves.toBeUndefined()
  })

  it('rejects candidate revisions before acceptance', async () => {
    await expect(
      assertPendingPurchasePacketApplyable(
        fakeGateDb({
          current_packet_id: 122,
          is_applyable: false,
          packet_root_id: 1,
          revision_status: 'candidate',
        }),
        123,
      ),
    ).rejects.toBeInstanceOf(PendingPurchaseRefinementConflictError)
  })
})

function fakeGateDb(row: Record<string, unknown>, hasSchema = true): Queryable {
  let calls = 0
  return {
    async query() {
      calls += 1
      if (calls === 1) {
        return {
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{
            has_packet_roots: hasSchema,
            has_packet_revision_status: hasSchema,
            has_refinement_turns: hasSchema,
            has_row_lineage: hasSchema,
          }],
        }
      }
      return { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [row] }
    },
  }
}
