import { describe, expect, it } from 'vitest'

import { __test__ } from './catalogReviewRerunRowJob.js'

describe('catalogReviewRerunRowJob.scopeKindToEntityType', () => {
  it('maps proposal_line_item to proposal_line_item entity type', () => {
    expect(__test__.scopeKindToEntityType('proposal_line_item')).toBe('proposal_line_item')
  })

  it('maps pending_purchase_row to pending_purchase_row entity type', () => {
    expect(__test__.scopeKindToEntityType('pending_purchase_row')).toBe('pending_purchase_row')
  })

  it('maps pending_purchase_packet to pending_purchase_packet entity type', () => {
    expect(__test__.scopeKindToEntityType('pending_purchase_packet')).toBe('pending_purchase_packet')
  })

  it('maps proposal_batch to proposal_batch entity type', () => {
    expect(__test__.scopeKindToEntityType('proposal_batch')).toBe('proposal_batch')
  })

  it('maps catalog_group to catalog_group entity type', () => {
    expect(__test__.scopeKindToEntityType('catalog_group')).toBe('catalog_group')
  })

  it('maps catalog_brand to catalog_brand entity type', () => {
    expect(__test__.scopeKindToEntityType('catalog_brand')).toBe('catalog_brand')
  })

  it('maps catalog_item to catalog_item entity type', () => {
    expect(__test__.scopeKindToEntityType('catalog_item')).toBe('catalog_item')
  })

  it('maps write_operation to write_operation entity type', () => {
    expect(__test__.scopeKindToEntityType('write_operation')).toBe('write_operation')
  })

  it('maps job to job entity type', () => {
    expect(__test__.scopeKindToEntityType('job')).toBe('job')
  })
})
