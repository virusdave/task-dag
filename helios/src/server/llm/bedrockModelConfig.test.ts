import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_STANDARD_REASONING_MODEL } from '../../shared/domain/bedrockModels.js'
import type { Queryable } from '../db/pool.js'
import {
  BEDROCK_MODEL_OVERRIDES_KEY,
  buildBedrockModelContextStates,
  loadBedrockModelOverrides,
  resolveBedrockModel,
} from './bedrockModelConfig.js'

// A db stub whose app_settings row carries `value`. A null value means "no
// row" (the key is absent).
function dbWithSetting(value: unknown): Queryable {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      const key = (params as string[] | undefined)?.[0]
      if (key === BEDROCK_MODEL_OVERRIDES_KEY && value !== null) {
        return {
          rows: [
            {
              key: BEDROCK_MODEL_OVERRIDES_KEY,
              value,
              updated_by: 'admin@test',
              updated_at: new Date('2026-06-21T00:00:00Z'),
            },
          ],
        }
      }
      return { rows: [] }
    },
  } as unknown as Queryable
}

describe('resolveBedrockModel', () => {
  it('falls back to the code default when no override row exists', async () => {
    const model = await resolveBedrockModel(dbWithSetting(null), 'pending_purchase_classifier')
    expect(model).toBe(DEFAULT_STANDARD_REASONING_MODEL)
  })

  it('returns the operator override when one is set', async () => {
    const db = dbWithSetting({
      version: 1,
      overrides: { pending_purchase_classifier: 'custom.reasoner-x' },
    })
    expect(await resolveBedrockModel(db, 'pending_purchase_classifier')).toBe('custom.reasoner-x')
  })

  it('ignores a malformed/old blob and uses the code default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = dbWithSetting({ version: 99, garbage: true })
    expect(await resolveBedrockModel(db, 'pending_purchase_classifier')).toBe(
      DEFAULT_STANDARD_REASONING_MODEL,
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('loadBedrockModelOverrides', () => {
  it('surfaces updatedBy/updatedAt on a valid row', async () => {
    const db = dbWithSetting({ version: 1, overrides: {} })
    const record = await loadBedrockModelOverrides(db)
    expect(record.updatedBy).toBe('admin@test')
    expect(record.updatedAt).toBe('2026-06-21T00:00:00.000Z')
    expect(record.overrides).toEqual({})
  })
})

describe('buildBedrockModelContextStates', () => {
  it('computes effectiveModel as override-then-default', () => {
    const states = buildBedrockModelContextStates({
      pending_purchase_classifier: 'custom.reasoner-x',
    })
    const classifier = states.find((s) => s.key === 'pending_purchase_classifier')
    expect(classifier?.defaultModel).toBe(DEFAULT_STANDARD_REASONING_MODEL)
    expect(classifier?.overrideModel).toBe('custom.reasoner-x')
    expect(classifier?.effectiveModel).toBe('custom.reasoner-x')
  })

  it('uses the default as effective when no override is set', () => {
    const states = buildBedrockModelContextStates({})
    const classifier = states.find((s) => s.key === 'pending_purchase_classifier')
    expect(classifier?.overrideModel).toBeNull()
    expect(classifier?.effectiveModel).toBe(DEFAULT_STANDARD_REASONING_MODEL)
  })
})
