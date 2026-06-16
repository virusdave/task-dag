import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateEd25519Pem } from '../lp/signing.js'
import { buildBrandingOpaqueManifest, type BrandPresenceRow } from './manifest.js'
import { nonProductionFallbackPublicTokenSecret } from './opaqueRef.js'
import {
  newBrandingManifestId,
  publishBrandingOpaqueManifest,
  readBrandingPointerVersion,
  validateBrandingOpaqueManifest,
} from './publish.js'

const SECRET = nonProductionFallbackPublicTokenSecret

const ROWS: BrandPresenceRow[] = [
  { siteKey: 'bronx', sweedBrandId: 1234, brandName: 'Herb', forSaleVariantCount: 3, lastForSaleObservedAt: null },
  { siteKey: 'midtown', sweedBrandId: 42, brandName: 'Cannaballs', forSaleVariantCount: 1, lastForSaleObservedAt: null },
]

function buildResult() {
  return buildBrandingOpaqueManifest(ROWS, { secret: SECRET, secretSource: 'nonproduction-fallback' })
}

describe('newBrandingManifestId', () => {
  it('produces the canonical bom_ format in UTC', () => {
    expect(newBrandingManifestId(new Date('2026-06-16T14:03:12Z'))).toMatch(
      /^bom_2026-06-16_140312_[0-9a-f]{6}$/,
    )
  })
})

describe('publish + validate roundtrip', () => {
  let root: string
  const keys = generateEd25519Pem()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'branding-opaque-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('publishes a signed manifest + pointer that validates', () => {
    const result = publishBrandingOpaqueManifest({
      buildResult: buildResult(),
      privateKeyPem: keys.privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      automationGitSha: 'abc1234',
    })
    expect(result.version).toBe(1)
    expect(result.entryCount).toBe(2)

    const v = validateBrandingOpaqueManifest({
      artifactRoot: root,
      environment: 'nonprod',
      publicKeyPem: keys.publicKeyPem,
    })
    expect(v).toMatchObject({ ok: true, errors: [], version: 1, entryCount: 2 })
  })

  it('increments the monotonic version on republish', () => {
    publishBrandingOpaqueManifest({
      buildResult: buildResult(),
      privateKeyPem: keys.privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      automationGitSha: 'abc1234',
    })
    const pointerPath = join(root, 'branding-opaque', 'nonprod', 'current.json')
    expect(readBrandingPointerVersion(pointerPath)).toBe(1)

    const second = publishBrandingOpaqueManifest({
      buildResult: buildResult(),
      privateKeyPem: keys.privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      automationGitSha: 'abc1234',
    })
    expect(second.version).toBe(2)
  })

  it('fails validation against a different public key', () => {
    publishBrandingOpaqueManifest({
      buildResult: buildResult(),
      privateKeyPem: keys.privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      automationGitSha: 'abc1234',
    })
    const v = validateBrandingOpaqueManifest({
      artifactRoot: root,
      environment: 'nonprod',
      publicKeyPem: generateEd25519Pem().publicKeyPem,
    })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('signature'))).toBe(true)
  })

  it('detects a tampered manifest (sha256 mismatch)', () => {
    const result = publishBrandingOpaqueManifest({
      buildResult: buildResult(),
      privateKeyPem: keys.privateKeyPem,
      artifactRoot: root,
      environment: 'nonprod',
      automationGitSha: 'abc1234',
    })
    const manifestPath = join(result.manifestDir, 'manifest.json')
    const tampered = readFileSync(manifestPath, 'utf8').replace('h78SFgtcQNLHNzKo37r1', 'TAMPEREDxxxxxxxxxxxx')
    writeFileSync(manifestPath, tampered)

    const v = validateBrandingOpaqueManifest({
      artifactRoot: root,
      environment: 'nonprod',
      publicKeyPem: keys.publicKeyPem,
    })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('sha256'))).toBe(true)
  })
})
