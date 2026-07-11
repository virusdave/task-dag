import { describe, expect, it } from 'vitest'

import { isCannabisCategory } from './catalog.js'

describe('isCannabisCategory', () => {
  it.each([
    ['Accessories', false],
    [' Other ', false],
    ['accessories', true],
    [null, true],
    ['', true],
    ['Flower', true],
  ] as const)('classifies %s as %s', (categoryName, expected) => {
    expect(isCannabisCategory(categoryName)).toBe(expected)
  })
})
