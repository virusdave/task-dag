import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  AssetsSchema,
  ContentSchema,
  CurrentPointerSchema,
  ManifestSchema,
  PolicySchema,
  SeoEventsBatchSchema,
  SitemapsSchema,
  WidgetsSchema,
} from './contracts.js'
import { checkSeoConsistency } from './consistency.js'

// Repo root is four levels up from helios/src/server/seo/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const examplesDir = join(repoRoot, 'config', 'seo', 'examples')

function loadExample(name: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, name), 'utf8'))
}

const cases: Array<[string, z.ZodTypeAny]> = [
  ['current.v1.json', CurrentPointerSchema],
  ['bundle-manifest.v1.json', ManifestSchema],
  ['widgets.v1.json', WidgetsSchema],
  ['content.v1.json', ContentSchema],
  ['policy.v1.json', PolicySchema],
  ['assets.v1.json', AssetsSchema],
  ['sitemaps.v1.json', SitemapsSchema],
  ['seo-events-batch.v1.json', SeoEventsBatchSchema],
]

describe('frozen SEO contract example fixtures conform to the zod mirror', () => {
  for (const [file, schema] of cases) {
    it(`${file} validates`, () => {
      const result = schema.safeParse(loadExample(file))
      if (!result.success) {
        throw new Error(`${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      }
      expect(result.success).toBe(true)
    })
  }

  it('the example bundle (manifest + widgets/content/policy/assets/sitemaps + pointer kill-list) is cross-consistent', () => {
    const manifest = ManifestSchema.parse(loadExample('bundle-manifest.v1.json'))
    const pointer = CurrentPointerSchema.parse(loadExample('current.v1.json'))
    const errors = checkSeoConsistency({
      sites: manifest.sites,
      widgets: WidgetsSchema.parse(loadExample('widgets.v1.json')),
      content: ContentSchema.parse(loadExample('content.v1.json')),
      policy: PolicySchema.parse(loadExample('policy.v1.json')),
      assets: AssetsSchema.parse(loadExample('assets.v1.json')),
      sitemaps: SitemapsSchema.parse(loadExample('sitemaps.v1.json')),
      disabledContent: pointer.disabled_content ?? [],
    })
    expect(errors).toEqual([])
  })
})
