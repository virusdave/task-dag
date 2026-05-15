import { describe, expect, it } from 'vitest'

import { deriveBasePathFromAppBaseUrl, joinBasePath, normalizeBasePath, toViteBasePath } from './appBasePath.js'

describe('appBasePath helpers', () => {
  it('derives the mounted app path from the configured base URL', () => {
    expect(deriveBasePathFromAppBaseUrl('https://freshlybaked.nyc/internal/tools')).toBe('/internal/tools')
    expect(deriveBasePathFromAppBaseUrl('https://freshlybaked.nyc/')).toBe('/')
  })

  it('joins application-relative paths without duplicating slashes', () => {
    expect(joinBasePath('/internal/tools/', '/api/session')).toBe('/internal/tools/api/session')
    expect(joinBasePath('/', '/review')).toBe('/review')
  })

  it('normalizes and exports a Vite-compatible base path', () => {
    expect(normalizeBasePath('internal/tools/')).toBe('/internal/tools')
    expect(toViteBasePath('/internal/tools')).toBe('/internal/tools/')
  })
})
