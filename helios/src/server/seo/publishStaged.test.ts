import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateEd25519Pem } from '../lp/signing.js'
import { compileSeoBundle } from './compile.js'
import { readSeoPointerVersion } from './publish.js'
import { publishSeoBundleStaged, StagedSeoPublishError } from './publishStaged.js'
import { validateSeoBundle } from './validate.js'
import { validCompileInput } from './__tests__/fixtures.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'seo-staged-publish-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function stage(opts: { publicKeyPem?: string; now?: Date } = {}) {
  const compiled = compileSeoBundle({ ...validCompileInput(), now: opts.now })
  return publishSeoBundleStaged({
    compiled,
    privateKeyPem,
    publicKeyPem: opts.publicKeyPem ?? publicKeyPem,
    artifactRoot: root,
    environment: 'nonprod',
    minRendererVersion: 'mss-seo-runtime>=0.1.0',
    automationGitSha: 'abc1234',
    generatedFrom: { seo_policy_version_id: 'seopol_test_01' },
    now: opts.now,
  })
}

describe('publishSeoBundleStaged', () => {
  it('promotes a validated bundle to the live pointer with a monotonic bump', () => {
    const livePointer = join(root, 'nonprod', 'current.json')
    const before = readSeoPointerVersion(livePointer)

    const result = stage()

    expect(result.version).toBe(before + 1)
    expect(result.pointerPath).toBe(livePointer)
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: livePointer,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.ok).toBe(true)
    expect(v.seoBundleId).toBe(result.seoBundleId)
    // No leftover pending pointer.
    expect(existsSync(join(root, 'nonprod', 'current.pending.json'))).toBe(false)
  })

  it('leaves the live pointer UNTOUCHED when pre-promotion validation fails', () => {
    // Establish a known-good live pointer first.
    const good = stage()
    const livePointer = join(root, 'nonprod', 'current.json')
    const liveVersionBefore = readSeoPointerVersion(livePointer)
    expect(liveVersionBefore).toBe(good.version)

    // Now attempt a staged publish that validates against the WRONG key, so
    // the pending pointer fails signature validation before promotion.
    const wrong = generateEd25519Pem()
    expect(() => stage({ publicKeyPem: wrong.publicKeyPem })).toThrow(StagedSeoPublishError)

    // The live pointer must be exactly as it was — never swapped.
    const liveVersionAfter = readSeoPointerVersion(livePointer)
    expect(liveVersionAfter).toBe(liveVersionBefore)
    const v = validateSeoBundle({
      artifactRoot: root,
      pointerPath: livePointer,
      publicKeyPem,
      runningRendererVersion: '0.1.0',
    })
    expect(v.ok).toBe(true)
    expect(v.seoBundleId).toBe(good.seoBundleId)
    // The failed staged publish cleaned up its pending pointer.
    expect(existsSync(join(root, 'nonprod', 'current.pending.json'))).toBe(false)
  })
})
