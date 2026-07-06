import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  insertAdvisoryEntry,
  renderAdvisoryEntryLine,
  validateCatalog,
  validateCatalogYaml,
  type AdvisoryEntry,
} from './advisoryCatalog.js'

// A minimal contract-valid catalog we can mutate per-test.
function baseCatalog(): Record<string, unknown> {
  return {
    version: 1,
    budget: { max_total_tokens: 500, max_advisories: 5, default_expires_after_days: 14 },
    ranking: {
      severity_weights: { safety: 1000, high: 8, medium: 3, low: 1 },
      recurrence_window_days: 14,
      age_halflife_days: 7,
    },
    advisories: [],
  }
}

function activeEntry(overrides: Partial<AdvisoryEntry> = {}): AdvisoryEntry {
  return {
    id: 'some-footgun',
    status: 'active',
    scope: 'global',
    severity: 'medium',
    max_tokens: 35,
    text: 'One-line reminder an agent can act on cold.',
    trigger_ids: ['some-footgun-observed'],
    expires_after_days: 14,
    added: '2026-07-06',
    ...overrides,
  }
}

describe('validateCatalog — happy path', () => {
  it('accepts the empty starter catalog', () => {
    const res = validateCatalog(baseCatalog())
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
  })

  it('accepts a catalog with active, permanent-safety, and retired entries', () => {
    const doc = baseCatalog()
    doc.advisories = [
      activeEntry(),
      {
        id: 'safety-thing',
        status: 'permanent-safety',
        scope: 'global',
        severity: 'safety',
        max_tokens: 40,
        text: 'Never do the dangerous thing.',
        trigger_ids: [],
        added: '2026-07-06',
      },
      {
        id: 'old-thing',
        status: 'retired',
        scope: 'repo:owner/repo',
        severity: 'low',
        max_tokens: 20,
        text: 'Retired prose kept for provenance.',
        trigger_ids: ['old-thing-observed'],
        added: '2026-07-06',
      },
    ]
    const res = validateCatalog(doc)
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })
})

describe('validateCatalog — contract violations', () => {
  it('rejects an unknown top-level key', () => {
    const doc = { ...baseCatalog(), surprise: true }
    const res = validateCatalog(doc)
    expect(res.ok).toBe(false)
    expect(res.errors.join(' ')).toContain('unknown top-level key')
  })

  it('rejects wrong version', () => {
    const doc = { ...baseCatalog(), version: 2 }
    expect(validateCatalog(doc).errors.join(' ')).toContain('version must be 1')
  })

  it('rejects budget over the design ceilings', () => {
    const doc = baseCatalog()
    doc.budget = { max_total_tokens: 999, max_advisories: 9, default_expires_after_days: 30 }
    const errs = validateCatalog(doc).errors.join(' ')
    expect(errs).toContain('max_total_tokens must be ≤ 500')
    expect(errs).toContain('max_advisories must be ≤ 5')
    expect(errs).toContain('default_expires_after_days must be in [7, 14]')
  })

  it('rejects a non-positive severity weight', () => {
    const doc = baseCatalog()
    ;(doc.ranking as Record<string, unknown>).severity_weights = { safety: 1000, high: 8, medium: 0, low: 1 }
    // an entry using medium is fine key-wise; the weight itself is invalid
    expect(validateCatalog(doc).errors.join(' ')).toContain('severity_weights.medium must be a number > 0')
  })

  it('rejects an unknown severity_weights key', () => {
    const doc = baseCatalog()
    ;(doc.ranking as Record<string, unknown>).severity_weights = {
      safety: 1000,
      high: 8,
      medium: 3,
      low: 1,
      critical: 5,
    }
    expect(validateCatalog(doc).errors.join(' ')).toContain('unknown ranking.severity_weights key "critical"')
  })

  it('rejects an unknown field on an entry', () => {
    const doc = baseCatalog()
    doc.advisories = [{ ...activeEntry(), bogus: 'x' }]
    expect(validateCatalog(doc).errors.join(' ')).toContain('unknown field(s): bogus')
  })

  it('rejects a non-kebab-case id and duplicate ids', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry({ id: 'NotKebab' }), activeEntry()]
    const errs = validateCatalog(doc).errors.join(' ')
    expect(errs).toContain('must be kebab-case')
  })

  it('rejects duplicate ids', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry(), activeEntry()]
    expect(validateCatalog(doc).errors.join(' ')).toContain('is duplicated')
  })

  it('rejects text over max_tokens', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry({ max_tokens: 2, text: 'this text is definitely more than two tokens long indeed' })]
    expect(validateCatalog(doc).errors.join(' ')).toContain('over max_tokens')
  })

  it('rejects max_tokens over budget.max_total_tokens', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry({ max_tokens: 600 })]
    expect(validateCatalog(doc).errors.join(' ')).toContain('must be ≤ budget.max_total_tokens')
  })

  it('rejects an active entry with no trigger_ids', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry({ trigger_ids: [] })]
    expect(validateCatalog(doc).errors.join(' ')).toContain('active but has no trigger_ids')
  })

  it('rejects a permanent-safety entry with expires_after_days', () => {
    const doc = baseCatalog()
    doc.advisories = [
      {
        id: 'ps',
        status: 'permanent-safety',
        scope: 'global',
        severity: 'safety',
        max_tokens: 40,
        text: 'x y z',
        trigger_ids: [],
        expires_after_days: 10,
        added: '2026-07-06',
      },
    ]
    expect(validateCatalog(doc).errors.join(' ')).toContain('must not set expires_after_days')
  })

  it('rejects a severity with no ranking weight', () => {
    const doc = baseCatalog()
    ;(doc.ranking as Record<string, unknown>).severity_weights = { high: 8, medium: 3, low: 1 }
    doc.advisories = [activeEntry({ severity: 'safety' })]
    expect(validateCatalog(doc).errors.join(' ')).toContain('no ranking.severity_weights entry')
  })

  it('rejects a bad scope and a bad date', () => {
    const doc = baseCatalog()
    doc.advisories = [activeEntry({ scope: 'repo:noowner', added: '2026/07/06' })]
    const errs = validateCatalog(doc).errors.join(' ')
    expect(errs).toContain('scope must be')
    expect(errs).toContain('added must be a YYYY-MM-DD')
  })

  it('surfaces a YAML parse error', () => {
    const res = validateCatalogYaml('version: 1\n  bad: [indent')
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toContain('YAML parse error')
  })
})

describe('renderAdvisoryEntryLine', () => {
  it('renders a single-line block-sequence flow mapping in contract field order', () => {
    const line = renderAdvisoryEntryLine(activeEntry())
    expect(line.startsWith('  - {')).toBe(true)
    expect(line).not.toContain('\n')
    // Round-trips back to the same object.
    const parsed = yaml.load(line.replace(/^ {2}- /, '')) as Record<string, unknown>
    expect(parsed.id).toBe('some-footgun')
    expect(parsed.trigger_ids).toEqual(['some-footgun-observed'])
    // Field order: id first.
    expect(Object.keys(parsed)[0]).toBe('id')
  })

  it('omits optional fields when absent', () => {
    const line = renderAdvisoryEntryLine(
      activeEntry({ expires_after_days: undefined, promote_to_guardrail: undefined, notes: undefined }),
    )
    expect(line).not.toContain('expires_after_days')
    expect(line).not.toContain('promote_to_guardrail')
    expect(line).not.toContain('notes')
  })

  it('safely serializes text containing YAML-special characters', () => {
    const line = renderAdvisoryEntryLine(activeEntry({ text: 'use rg: never {this}, [that] # ok' }))
    expect(line).not.toContain('\n')
    const parsed = yaml.load(line.replace(/^ {2}- /, '')) as Record<string, unknown>
    expect(parsed.text).toBe('use rg: never {this}, [that] # ok')
  })
})

describe('insertAdvisoryEntry', () => {
  const empty = [
    '# header comment',
    'version: 1',
    'budget: { max_total_tokens: 500, max_advisories: 5, default_expires_after_days: 14 }',
    'ranking:',
    '  severity_weights: { safety: 1000, high: 8, medium: 3, low: 1 }',
    '  recurrence_window_days: 14',
    '  age_halflife_days: 7',
    'advisories: []',
    '',
    '# ─── SCHEMA BY EXAMPLE (commented) ───',
    '#   - { id: example, ... }',
    '',
  ].join('\n')

  it('converts an empty inline list to a one-item block sequence, preserving comments', () => {
    const line = renderAdvisoryEntryLine(activeEntry())
    const res = insertAdvisoryEntry(empty, line)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('# header comment')
    expect(res.text).toContain('# ─── SCHEMA BY EXAMPLE')
    expect(res.text).toContain('advisories:\n  - {')
    const parsed = validateCatalogYaml(res.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.catalog?.advisories).toHaveLength(1)
  })

  it('appends after the last item in an existing block sequence', () => {
    const line1 = renderAdvisoryEntryLine(activeEntry({ id: 'first', trigger_ids: ['first-obs'] }))
    const withOne = insertAdvisoryEntry(empty, line1)
    expect(withOne.ok).toBe(true)
    if (!withOne.ok) return
    const line2 = renderAdvisoryEntryLine(activeEntry({ id: 'second', trigger_ids: ['second-obs'] }))
    const withTwo = insertAdvisoryEntry(withOne.text, line2)
    expect(withTwo.ok).toBe(true)
    if (!withTwo.ok) return
    const parsed = validateCatalogYaml(withTwo.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.catalog?.advisories.map((a) => a.id)).toEqual(['first', 'second'])
    // The schema-example comment block is still intact and still below the entries.
    expect(withTwo.text).toContain('# ─── SCHEMA BY EXAMPLE')
  })

  it('refuses an unsupported inline value shape', () => {
    const weird = 'advisories: [ { id: x } ]\n'
    const res = insertAdvisoryEntry(weird, '  - { id: y }')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('catalog_edit_unsupported')
  })

  it('refuses when there is no advisories key', () => {
    const res = insertAdvisoryEntry('version: 1\n', '  - { id: y }')
    expect(res.ok).toBe(false)
  })
})
