import { describe, expect, it, vi } from 'vitest'

import { buildFamilyFaqUserPrompt, generateFamilyFaqDraft } from './faqFamilyGenerate.js'
import * as faqGenerate from './faqGenerate.js'
import { getLpFamily } from './lpFamilyRegistry.js'

describe('buildFamilyFaqUserPrompt', () => {
  it('embeds the family id, canonical route, and sample routes from the registry', () => {
    const family = getLpFamily('deliverance')!
    const prompt = buildFamilyFaqUserPrompt(family, { familyId: 'deliverance', itemCount: 4 })
    expect(prompt).toContain('"deliverance"')
    expect(prompt).toContain(family.canonical_representative_route)
    expect(prompt).toContain('/bronx/deliverance/bronx/1')
    expect(prompt).toContain('number_of_faq_items: 4')
    expect(prompt).not.toContain('operator_focus:')
  })

  it('includes the operator focus when provided', () => {
    const family = getLpFamily('compare')!
    const prompt = buildFamilyFaqUserPrompt(family, {
      familyId: 'compare',
      itemCount: 3,
      focus: 'why choose us over competitors',
    })
    expect(prompt).toContain('operator_focus: "why choose us over competitors"')
  })
})

describe('generateFamilyFaqDraft', () => {
  it('errors on an unknown family without calling the gateway', async () => {
    const spy = vi.spyOn(faqGenerate, 'requestFaqItems')
    const result = await generateFamilyFaqDraft({ familyId: 'not-a-family', itemCount: 3 })
    expect(result.kind).toBe('error')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('stamps the FBUS source key, route scoping, and registry provenance on success', async () => {
    const spy = vi.spyOn(faqGenerate, 'requestFaqItems').mockResolvedValue({
      kind: 'ok',
      model: 'test-model',
      items: [
        {
          question: 'How does delivery work?',
          answer_raw: 'We deliver cannabis across the boroughs.',
          answer_sanitized: 'We deliver across the boroughs.',
        },
      ],
    })
    const result = await generateFamilyFaqDraft({ familyId: 'conquest', itemCount: 1 })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    // alias `conquest` normalizes to canonical `compare`
    expect(result.meta.familyId).toBe('compare')
    expect(result.meta.sourceKey).toBe('fbus-compare-faq')
    expect(result.meta.siteId).toBe('freshlybakedus')
    expect(result.meta.routePatterns.length).toBeGreaterThan(0)
    expect(result.meta.registryProvenance.repo).toBe('Nicponskis/mostly-static-sites')
    expect(result.meta.registryProvenance.blobSha).toMatch(/^[0-9a-f]{40}$/)
    spy.mockRestore()
  })

  it('surfaces pre-review governance warnings (advisory) — empty when clean, populated on a draft marker', async () => {
    const clean = vi.spyOn(faqGenerate, 'requestFaqItems').mockResolvedValue({
      kind: 'ok',
      model: 'test-model',
      items: [
        {
          question: 'How does delivery work?',
          answer_raw: 'We deliver across the boroughs.',
          answer_sanitized: 'We deliver across the boroughs.',
        },
      ],
    })
    const cleanResult = await generateFamilyFaqDraft({ familyId: 'tours', itemCount: 1 })
    expect(cleanResult.kind).toBe('ok')
    if (cleanResult.kind === 'ok') {
      expect(cleanResult.meta.governanceWarnings).toEqual([])
    }
    clean.mockRestore()

    const dirty = vi.spyOn(faqGenerate, 'requestFaqItems').mockResolvedValue({
      kind: 'ok',
      model: 'test-model',
      items: [
        {
          question: 'What is this?',
          answer_raw: 'TODO: write this answer',
          answer_sanitized: 'TODO: write this answer',
        },
      ],
    })
    const dirtyResult = await generateFamilyFaqDraft({ familyId: 'tours', itemCount: 1 })
    expect(dirtyResult.kind).toBe('ok')
    if (dirtyResult.kind === 'ok') {
      expect(dirtyResult.meta.governanceWarnings.length).toBeGreaterThan(0)
      expect(dirtyResult.meta.governanceWarnings.join('\n')).toContain('forbidden_term')
    }
    dirty.mockRestore()
  })

  it('flags a sanitized variant that leaks a cannabis meta-term (FBUS-strict, advisory)', async () => {
    const spy = vi.spyOn(faqGenerate, 'requestFaqItems').mockResolvedValue({
      kind: 'ok',
      model: 'test-model',
      items: [
        {
          question: 'What products do you carry?',
          answer_raw: 'We carry a wide range of cannabis flower.',
          // deliberate leak: "flower" is an FBUS-strict meta-term
          answer_sanitized: 'We carry a wide range of flower.',
        },
      ],
    })
    const result = await generateFamilyFaqDraft({ familyId: 'branding', itemCount: 1 })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.meta.sanitizedLeakWarnings).toHaveLength(1)
    expect(result.meta.sanitizedLeakWarnings[0]!.itemIndex).toBe(0)
    expect(result.meta.sanitizedLeakWarnings[0]!.terms).toContain('flower')
    spy.mockRestore()
  })

  it('propagates a gateway error', async () => {
    const spy = vi.spyOn(faqGenerate, 'requestFaqItems').mockResolvedValue({
      kind: 'error',
      message: 'boom',
    })
    const result = await generateFamilyFaqDraft({ familyId: 'tours', itemCount: 2 })
    expect(result).toEqual({ kind: 'error', message: 'boom' })
    spy.mockRestore()
  })
})
