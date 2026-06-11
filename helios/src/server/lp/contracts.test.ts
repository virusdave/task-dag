import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  AssetsSchema,
  BundleSchema,
  CurrentPointerSchema,
  LpEventsBatchSchema,
  ManifestSchema,
  PolicySchema,
} from './contracts.js'

// Repo root is four levels up from helios/src/server/lp/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const examplesDir = join(repoRoot, 'config', 'landing-pages', 'examples')

function loadExample(name: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, name), 'utf8'))
}

const cases: Array<[string, z.ZodTypeAny]> = [
  ['current.v1.json', CurrentPointerSchema],
  ['bundle-manifest.v1.json', ManifestSchema],
  ['bundle.v1.json', BundleSchema],
  ['policy.v1.json', PolicySchema],
  ['assets.v1.json', AssetsSchema],
  ['lp-events-batch.v1.json', LpEventsBatchSchema],
]

describe('frozen contract example fixtures conform to the zod mirror', () => {
  for (const [file, schema] of cases) {
    it(`${file} validates`, () => {
      const result = schema.safeParse(loadExample(file))
      if (!result.success) {
        throw new Error(`${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      }
      expect(result.success).toBe(true)
    })
  }
})
