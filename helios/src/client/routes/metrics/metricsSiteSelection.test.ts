import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SITE_ID,
  defaultSiteSelection,
  normaliseSiteSelection,
  toggleSiteSelection,
} from './metricsSiteSelection.js'

const ids = (s: ReadonlySet<string>) => [...s].sort()

describe('toggleSiteSelection (radio / switch-focus semantics)', () => {
  it('focuses a site when coming from the All (empty) view', () => {
    expect(ids(toggleSiteSelection(new Set(), 'bronx', 2))).toEqual(['bronx'])
  })

  it('SWITCHES focus to the tapped site (never infers All, never multi-selects)', () => {
    // The operator's core report: Bronx active, tap Midtown -> only Midtown.
    expect(ids(toggleSiteSelection(new Set(['bronx']), 'midtown', 2))).toEqual(['midtown'])
  })

  it('is a no-op (same reference) when re-tapping the already-focused sole chip', () => {
    const prev = new Set(['bronx'])
    // Never toggles off to All — the explicit All chip is the only path there.
    expect(toggleSiteSelection(prev, 'bronx', 2)).toBe(prev)
  })

  it('collapses a legacy multi-site state down to the tapped site', () => {
    expect(ids(toggleSiteSelection(new Set(['bronx', 'midtown']), 'midtown', 2))).toEqual([
      'midtown',
    ])
  })

  it('never returns the empty (All) set from a chip tap, regardless of site count', () => {
    expect(toggleSiteSelection(new Set(['bronx', 'midtown']), 'queens', 3).size).toBe(1)
    expect(toggleSiteSelection(new Set(['bronx']), 'bronx', 5).size).toBe(1)
  })
})

describe('normaliseSiteSelection', () => {
  it('keeps All (empty) as All', () => {
    expect(normaliseSiteSelection(new Set(), 2).size).toBe(0)
  })

  it('collapses an explicit full set to All (legacy/deep-link canonicalisation)', () => {
    expect(normaliseSiteSelection(new Set(['bronx', 'midtown']), 2).size).toBe(0)
  })

  it('keeps a single concrete site as-is', () => {
    expect(ids(normaliseSiteSelection(new Set(['bronx']), 2))).toEqual(['bronx'])
  })

  it('reduces a strict multi-site subset to one deterministic site', () => {
    expect(normaliseSiteSelection(new Set(['bronx', 'midtown']), 3).size).toBe(1)
  })
})

describe('defaultSiteSelection', () => {
  it('seeds the default concrete site, not the All view', () => {
    expect(ids(defaultSiteSelection(['bronx', 'midtown']))).toEqual([DEFAULT_SITE_ID])
  })

  it('falls back to All only when the default site is unknown', () => {
    expect(defaultSiteSelection(['bronx']).size).toBe(0)
  })
})
