import { describe, expect, it } from 'vitest'

import {
  HINT_BUNDLE_ID_RE,
  HINT_DOCUMENT_ID_RE,
  hintDocumentContentSha256,
  newHintBundleId,
  newHintDocumentId,
  normalizeHintText,
} from './hintContent.js'

describe('newHintBundleId / newHintDocumentId', () => {
  it('match the structured id grammar and embed the UTC timestamp', () => {
    const now = new Date('2026-06-20T22:35:26.000Z')
    const bundleId = newHintBundleId(now)
    const documentId = newHintDocumentId(now)
    expect(bundleId).toMatch(HINT_BUNDLE_ID_RE)
    expect(documentId).toMatch(HINT_DOCUMENT_ID_RE)
    expect(bundleId.startsWith('pphint_2026-06-20_223526_')).toBe(true)
    expect(documentId.startsWith('pphdoc_2026-06-20_223526_')).toBe(true)
  })

  it('mint distinct ids for the same instant (random suffix)', () => {
    const now = new Date('2026-06-20T22:35:26.000Z')
    expect(newHintBundleId(now)).not.toBe(newHintBundleId(now))
    expect(newHintDocumentId(now)).not.toBe(newHintDocumentId(now))
  })
})

describe('normalizeHintText', () => {
  it('normalizes CRLF/CR to LF and trims the ends', () => {
    expect(normalizeHintText('  line1\r\nline2\rline3  \n')).toBe('line1\nline2\nline3')
  })

  it('preserves internal whitespace (column-aligned menus stay meaningful)', () => {
    expect(normalizeHintText('SKU    Name      Cost')).toBe('SKU    Name      Cost')
  })
})

describe('hintDocumentContentSha256', () => {
  it('is a 64-char lowercase hex digest', () => {
    expect(hintDocumentContentSha256('hello')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable and content-addressed (dedup key)', () => {
    expect(hintDocumentContentSha256('same text')).toBe(hintDocumentContentSha256('same text'))
    expect(hintDocumentContentSha256('a')).not.toBe(hintDocumentContentSha256('b'))
  })

  it('collides for inputs that normalize to the same text', () => {
    const a = normalizeHintText('  menu line\r\n')
    const b = normalizeHintText('menu line')
    expect(hintDocumentContentSha256(a)).toBe(hintDocumentContentSha256(b))
  })
})
