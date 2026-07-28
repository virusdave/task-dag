import { describe, expect, it } from 'vitest'

import type { Queryable } from '../pool.js'
import {
  assertBaseRowsMatchSnapshot,
  assertPendingPurchasePacketApplyable,
  createPendingPurchaseCandidateRevision,
  hashJsonForPendingPurchaseRefinement,
  listPendingPurchaseRefinementHistory,
  lockPendingPurchasePacketRootForApply,
  markPendingPurchaseRefinementTurnFailed,
  PendingPurchaseRefinementConflictError,
  switchPendingPurchaseCurrentRevision,
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
  it('allows ready legacy unrooted packets after migration', async () => {
    await expect(assertPendingPurchasePacketApplyable(fakeGateDb({ packet_root_id: null, status: 'ready' }), 123)).resolves.toBeUndefined()
  })

  it('rejects superseded unrooted packets after migration', async () => {
    await expect(
      assertPendingPurchasePacketApplyable(fakeGateDb({ packet_root_id: null, status: 'superseded' }), 123),
    ).rejects.toBeInstanceOf(PendingPurchaseRefinementConflictError)
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
          root_status: 'active',
          status: 'ready',
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
          root_status: 'active',
          status: 'superseded',
        }),
        123,
      ),
    ).rejects.toBeInstanceOf(PendingPurchaseRefinementConflictError)
  })
})

describe('lockPendingPurchasePacketRootForApply', () => {
  it('takes the packet-root lock used to serialize apply and revision switching', async () => {
    const calls: RecordedQuery[] = []
    const db = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params })
        if (calls.length === 1) return resultRows([{ schema_applied: true }])
        return resultRows([{ id: 77 }])
      },
    }

    await lockPendingPurchasePacketRootForApply(db, 100)

    expect(calls[1]?.text).toMatch(/for update of r/i)
    expect(calls[1]?.params).toEqual([100])
  })
})

describe('createPendingPurchaseCandidateRevision', () => {
  it('materializes validated patches without making the candidate current/applyable', async () => {
    const db = fakeCandidateCreationDb()

    await expect(createPendingPurchaseCandidateRevision(db, 9001, refinement(db.expectedSnapshotSha256))).resolves.toEqual({
      candidatePacketId: 101,
      revisionNumber: 2,
    })

    expect(db.calls[0]?.text).toMatch(/lock table pending_purchase_packets in row exclusive mode/i)
    const insertPacket = db.calls.find((call) => /insert into pending_purchase_packets/i.test(call.text))
    expect(insertPacket?.text).toMatch(/'candidate'/)
    expect(insertPacket?.text).toMatch(/false,\s*id,\s*\$1/s)
    expect(insertPacket?.text).toMatch(/'superseded'/)
    expect(insertPacket?.text).toMatch(/summary_json \|\| jsonb_build_object/)
    expect(insertPacket?.text).not.toMatch(/summary_json\s*->\s*'classifier'/)
    const insertRows = db.calls.find((call) => /insert into pending_purchase_rows/i.test(call.text))
    expect(insertRows?.text).toMatch(/row_lineage_id,\s*id,\s*packet_id,\s*\$2/s)
    expect(insertRows?.text).toMatch(/lineage_revision_number \+ 1/)
    expect(insertRows?.text).toMatch(/'pending'/)
    expect(insertRows?.text).toMatch(/'not_requested'/)
    expect(insertRows?.text).toMatch(/jsonb_build_object\('targetReuseProductId', edited_structured_fields -> 'targetReuseProductId'\)/)
    const patchRows = db.calls.find((call) => /jsonb_to_recordset/i.test(call.text))
    expect(patchRows?.text).toMatch(/target_brand = case when patch\.fields \? 'targetBrand'/)
    expect(patchRows?.text).not.toMatch(/patch\.fields \? 'targetReuseProductId'/)
    expect(patchRows?.text).toMatch(/'mode', 'llm-patch'/)
    expect(patchRows?.text).toMatch(/nullif\(patch\.fields -> 'reviewFlags', 'null'::jsonb\)/)
    expect(patchRows?.params?.[0]).toContain('Pink Runtz')
    const completed = db.calls.find((call) => /set status = 'candidate_created'/i.test(call.text))
    expect(completed?.params).toEqual([
      9001,
      101,
      'test-model',
      'test-prompt-v1',
      '{"compactionLevel":"balanced","contextItemCount":4,"decisionCounts":{"changed":1,"unchanged":0,"not_applicable":0,"needs_review":0},"degradedProviders":[],"estimatedInputTokens":1200,"omittedContextItemCount":0,"overflowRetryCount":0,"patchCount":1,"rowDecisions":[{"citedContextIds":["catalog:pprline_501:7001"],"disposition":"changed","rationale":"Matches the offered catalog candidate.","rowLineageId":"pprline_501"}],"schemaVersion":2}',
    ])
  })

  it('rejects stale turns without inserting a candidate', async () => {
    const db = fakeCandidateCreationDb({ turnSnapshotSha256: 'c'.repeat(64) })

    await expect(createPendingPurchaseCandidateRevision(db, 9001, refinement(db.expectedSnapshotSha256))).rejects.toBeInstanceOf(
      PendingPurchaseRefinementConflictError,
    )

    expect(db.calls.some((call) => /insert into pending_purchase_packets/i.test(call.text))).toBe(false)
  })
})

describe('listPendingPurchaseRefinementHistory', () => {
  it('reviews every model-patchable field plus the operator-owned reuse link', async () => {
    const calls: string[] = []
    const db = {
      async query(text: string) {
        calls.push(text)
        if (/join pending_purchase_packet_roots/i.test(text)) {
          return resultRows([{
            current_packet_id: 100,
            current_revision_number: 1,
            id: 77,
            root_key: 'packet-root',
            root_status: 'active',
            updated_at: new Date('2026-07-25T12:00:00Z'),
            version: 1,
          }])
        }
        return resultRows([])
      },
    } as unknown as Queryable

    await listPendingPurchaseRefinementHistory(db, 100)

    const diffSql = calls.find((text) => /cross join lateral/i.test(text) && /diff\.field/i.test(text))
    for (const field of [
      'expectedCategory', 'expectedSubcategory', 'notes', 'primaryImageUrl', 'proposedDescription',
      'proposedPrice', 'reviewFlags', 'targetBrand', 'targetGroupName', 'targetPackCount',
      'targetReuseProductId', 'targetSize', 'targetStrainName', 'targetVariantName', 'targetVariantTab',
    ]) {
      expect(diffSql).toContain(`('${field}'`)
    }
    expect(diffSql).toMatch(/coalesce\(p\.edited_proposed_price, p\.proposed_price\)/)
    expect(diffSql).toMatch(/p\.edited_structured_fields \? 'targetBrand'/)
    expect(diffSql).toMatch(/p\.edited_structured_fields \? 'targetReuseProductId'/)
    expect(diffSql).toMatch(/else p\.raw_row_json -> 'reuseProductId'/)
    expect(diffSql).toMatch(/coalesce\(diff\.before, 'null'::jsonb\) is distinct from coalesce\(diff\.after, 'null'::jsonb\)/)
  })
})

function refinement(basePacketSnapshotSha256: string) {
  return {
    compactionLevel: 'balanced',
    contextItemCount: 4,
    degradedProviders: [],
    decisions: [{
      citedContextIds: ['catalog:pprline_501:7001'],
      disposition: 'changed' as const,
      rationale: 'Matches the offered catalog candidate.',
      rowLineageId: 'pprline_501',
    }],
    estimatedInputTokens: 1200,
    model: 'test-model',
    omittedContextItemCount: 0,
    overflowRetryCount: 0,
    patches: [{
      basePacketSnapshotSha256,
      citedContextIds: ['catalog:pprline_501:7001'],
      fields: { targetBrand: 'Pink Runtz' },
      rationale: 'Matches the offered catalog candidate.',
      rowLineageId: 'pprline_501',
    }],
    promptVersion: 'test-prompt-v1',
    schemaVersion: 2,
  }
}

describe('switchPendingPurchaseCurrentRevision', () => {
  it('rejects a revision switch while the current packet has an active apply', async () => {
    const db = {
      async query(text: string) {
        if (/lock table pending_purchase_packets/i.test(text)) return resultRows([], 'LOCK')
        if (/join pending_purchase_packet_roots/i.test(text)) {
          return resultRows([{
            current_packet_id: 100,
            current_revision_number: 1,
            id: 77,
            root_key: 'packet-root-77',
            root_status: 'active',
            updated_at: new Date(),
            version: 4,
          }])
        }
        if (/from pending_purchase_apply_requests/i.test(text)) return resultRows([{ id: 88 }])
        throw new Error(`Unexpected query: ${text}`)
      },
    }

    await expect(switchPendingPurchaseCurrentRevision(db as never, {
      expectedRootVersion: 4,
      packetId: 100,
      reason: 'test switch',
      selectedPacketId: 101,
      userId: 9,
    })).rejects.toThrow(/apply to finish/)
  })
})

describe('markPendingPurchaseRefinementTurnFailed', () => {
  it('cannot overwrite a candidate created by a concurrent worker', async () => {
    const calls: RecordedQuery[] = []
    await markPendingPurchaseRefinementTurnFailed({
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params })
        return resultRows([], 'UPDATE')
      },
    }, 9001, 'late failure')

    expect(calls[0]?.text).toMatch(/status in \('queued', 'running'\)/)
    expect(calls[0]?.text).toMatch(/candidate_packet_id is null/)
    expect(calls[0]?.params).toEqual([9001, 'late failure', null, null])
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
          rows: [{ schema_applied: hasSchema }],
        }
      }
      return { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [row] }
    },
  }
}

interface RecordedQuery {
  params: unknown[] | undefined
  text: string
}

function fakeCandidateCreationDb(options: { turnSnapshotSha256?: string } = {}) {
  const snapshotRow = {
    actionType: 'create',
    approvalStatus: 'approved',
    catalogAction: 'create_product',
    distributorProductId: 'dist-1',
    distributorProductName: 'Pink Runtz 3.5g',
    effectivePrimaryImageUrl: null,
    effectiveProposedDescription: 'Pink Runtz flower',
    effectiveProposedPrice: '32.00',
    editedStructuredFields: {},
    expectedCategory: 'Flower',
    expectedSubcategory: 'Packaged Eighth',
    lastApplyStatus: 'not_requested',
    lineageRevisionNumber: 1,
    mappingStatus: 'needs_catalog_create',
    notes: null,
    rawProvenance: { source: 'test' },
    refinementProvenance: {},
    reviewFlags: [],
    rowId: 501,
    rowLineageId: 'pprline_501',
    siteKey: 'bronx',
    targetBrand: 'Runtz',
    targetGroupName: 'Pink Runtz',
    targetVariantName: 'Pink Runtz 3.5g',
    version: 3,
  }
  const expectedSnapshotSha256 = hashJsonForPendingPurchaseRefinement({
    packetId: 100,
    revisionNumber: 1,
    rows: [snapshotRow],
  })
  const turnSnapshotSha256 = options.turnSnapshotSha256 ?? expectedSnapshotSha256
  const calls: RecordedQuery[] = []
  const db = {
    calls,
    expectedSnapshotSha256,
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params })
      if (/from pending_purchase_refinement_turns\s+where id = \$1\s+for update/is.test(text)) {
        return resultRows([{ candidate_packet_id: null, feedback_text: 'Fix Pink Runtz.', id: 9001, packet_root_id: 77, row_snapshot_sha256: turnSnapshotSha256, status: 'running', target_packet_id: 100, target_revision_number: 1, target_root_version: 4 }])
      }
      if (/from pending_purchase_packets p\s+join pending_purchase_packet_roots r/is.test(text)) {
        return resultRows([{ current_packet_id: 100, current_revision_number: 1, packet_root_id: 77, packet_title: 'Bronx packet r1', revision_number: 1, revision_status: 'current', root_key: 'pprroot_100', root_status: 'active', root_updated_at: new Date('2026-07-09T15:00:00.000Z'), root_version: 4 }])
      }
      if (/from pending_purchase_rows r\s+where r\.packet_id = \$1/is.test(text)) {
        return resultRows([
          {
            action_type: 'create',
            approval_status: 'approved',
            catalog_action: 'create_product',
            distributor_product_id: 'dist-1',
            distributor_product_name: 'Pink Runtz 3.5g',
            effective_primary_image_url: null,
            effective_proposed_description: 'Pink Runtz flower',
            effective_proposed_price: '32.00',
            edited_structured_fields: {},
            expected_category: 'Flower',
            expected_subcategory: 'Packaged Eighth',
            last_apply_status: 'not_requested',
            lineage_revision_number: 1,
            mapping_status: 'needs_catalog_create',
            notes: null,
            raw_row_json: snapshotRow.rawProvenance,
            refinement_provenance_json: {},
            review_flags_json: [],
            row_id: 501,
            row_lineage_id: 'pprline_501',
            row_snapshot_sha256: expectedSnapshotSha256,
            site_key: 'bronx',
            target_brand: 'Runtz',
            target_group_name: 'Pink Runtz',
            target_variant_name: 'Pink Runtz 3.5g',
            version: 3,
          },
        ])
      }
      if (/array_agg\(coalesce\(row_lineage_id, ''\)/i.test(text)) {
        return resultRows([{ lineages: ['pprline_501'] }])
      }
      if (/insert into pending_purchase_packets/i.test(text)) {
        return resultRows([{ id: 101, revision_number: 2 }], 'INSERT')
      }
      if (/insert into pending_purchase_rows/i.test(text)) {
        return { command: 'INSERT', fields: [], oid: 0, rowCount: 1, rows: [] }
      }
      return { command: 'UPDATE', fields: [], oid: 0, rowCount: 1, rows: [] }
    },
  }
  return db as unknown as import('pg').PoolClient & { calls: RecordedQuery[]; expectedSnapshotSha256: string }
}

function resultRows(rows: Record<string, unknown>[], command = 'SELECT') {
  return { command, fields: [], oid: 0, rowCount: rows.length, rows }
}
