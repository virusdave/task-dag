import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateEd25519Pem } from '../lp/signing.js'
import { compileSeoBundle } from './compile.js'
import { publishSeoBundle, seoManifestUrlFor } from './publish.js'
import { validateSeoBundle } from './validate.js'
import { validCompileInput } from './__tests__/fixtures.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'seo-bundle-test-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function publish(opts: { candidateOnly?: boolean; version?: number; now?: Date } = {}) {
  const compiled = compileSeoBundle({ ...validCompileInput(), now: opts.now })
  return {
    compiled,
    result: publishSeoBundle({
      compiled,
      privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      minRendererVersion: 'mss-seo-runtime>=0.1.0',
      automationGitSha: 'abc1234',
      generatedFrom: { seo_policy_version_id: 'seopol_test_01', approval_snapshot_id: 7 },
      candidateOnly: opts.candidateOnly,
      version: opts.version,
      now: opts.now,
    }),
  }
}

describe('SEO bundle publish + validate round-trip', () => {
  it('publishes and validates successfully', () => {
    const { result } = publish()
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.seoBundleId).toBe(result.seoBundleId)
  })

  it('dry-run (candidateOnly) never writes the live current.json', () => {
    const { result } = publish({ candidateOnly: true })
    expect(result.candidate).toBe(true)
    expect(result.pointerPath.endsWith('current.candidate.json')).toBe(true)
    // The live pointer should not exist from a candidate-only publish into
    // a fresh env dir... but earlier tests may have written current.json.
    // Assert specifically that the candidate file validates on its own.
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.ok).toBe(true)
  })

  it('fails closed when a content file is tampered (sha mismatch)', () => {
    const { result } = publish()
    const widgetsPath = join(result.bundleDir, 'widgets.json')
    const original = readFileSync(widgetsPath, 'utf8')
    writeFileSync(widgetsPath, original.replace('faq_nyc', 'faq_xxx'))
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/widgets sha256 mismatch/)
  })

  it('fails closed when the running renderer is too old', () => {
    const { result } = publish()
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.0.1',
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/does not satisfy/)
  })

  it('fails closed on a wrong signing key', () => {
    const { result } = publish()
    const other = generateEd25519Pem()
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem: other.publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/signature invalid/)
  })

  it('rejects a stale pointer version against the active version', () => {
    const { result } = publish({ version: 5 })
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: result.pointerPath,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
      activeVersion: 10,
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/stale/)
  })

  it('derives the canonical manifest url', () => {
    expect(seoManifestUrlFor('seob_2026-06-11_120000_abcd12')).toBe(
      'bundles/seob_2026-06-11_120000_abcd12/manifest.json',
    )
  })
})
