/**
 * configLoader — happy-path + a handful of negative paths.
 *
 * Uses the same TENANT_CONFIGS that the rest of the parsekit test
 * suite uses (via metrc-v1-fixtures.ts). We materialise them out to
 * a tmpdir in the layout the loader expects, then load them back
 * through the public surface.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { metrcV1Dialect } from '../dialects/metrc-v1.js'
import { pendingPurchasesContract } from '../contracts/pendingPurchases.js'
import { TENANT_CONFIGS } from './metrc-v1-fixtures.js'
import type { DialectPack, TenantParserConfig, UseCaseContract } from '../index.js'
import { loadParserConfigsFromDir, type LoaderRegistries } from '../node/configLoader.js'

function buildRegistries(): LoaderRegistries {
  return {
    dialects: new Map<string, DialectPack<unknown>>([
      ['metrc-v1', metrcV1Dialect as unknown as DialectPack<unknown>],
    ]),
    contracts: new Map<string, UseCaseContract<unknown>>([
      [
        pendingPurchasesContract.useCase,
        pendingPurchasesContract as unknown as UseCaseContract<unknown>,
      ],
    ]),
  }
}

function writeConfig(rootDir: string, cfg: TenantParserConfig): void {
  const dir = join(rootDir, 'use-cases', cfg.scope.useCase, 'parsers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${cfg.scope.tenantId}.jsonc`), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

describe('configLoader', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'parsekit-loader-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('loads, validates, compiles, and runs goldens for all 11 METRC tenants', () => {
    for (const cfg of TENANT_CONFIGS) writeConfig(tmpRoot, cfg)

    const { release, errors, considered } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'test-sha-1',
      registries: buildRegistries(),
    })

    expect(errors).toEqual([])
    expect(release).not.toBeNull()
    expect(considered.length).toBe(TENANT_CONFIGS.length)
    expect(release!.sha).toBe('test-sha-1')
    expect(release!.parsers.size).toBe(TENANT_CONFIGS.length)
    for (const cfg of TENANT_CONFIGS) {
      expect(release!.parsers.has(cfg.parserId)).toBe(true)
    }
    expect(release!.contractsByUseCase.get('pending-purchases')).toBeDefined()
  })

  it('returns directory_missing when the dir does not exist', () => {
    const { release, errors } = loadParserConfigsFromDir({
      dir: join(tmpRoot, 'does-not-exist'),
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.code).toBe('directory_missing')
  })

  it('rejects the whole snapshot when one file is broken', () => {
    const good = TENANT_CONFIGS[0]!
    writeConfig(tmpRoot, good)
    // Now plant a syntactically-broken JSONC alongside it.
    const badPath = join(tmpRoot, 'use-cases', good.scope.useCase, 'parsers', 'broken.jsonc')
    writeFileSync(badPath, '{ "this": is not valid jsonc', 'utf8')

    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.code === 'jsonc_parse_failed')).toBe(true)
  })

  it('rejects a config whose dialectRef.version does not match the pack', () => {
    const cfg = structuredClone(TENANT_CONFIGS[0]!) as TenantParserConfig
    cfg.dialectRef = { ...cfg.dialectRef, version: 999 }
    writeConfig(tmpRoot, cfg)

    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.some((e) => e.code === 'dialect_version_mismatch')).toBe(true)
  })

  it('rejects a config that references an unknown dialect id', () => {
    const cfg = structuredClone(TENANT_CONFIGS[0]!) as TenantParserConfig
    cfg.dialectRef = { id: 'does-not-exist', version: 1 }
    writeConfig(tmpRoot, cfg)

    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.some((e) => e.code === 'dialect_unknown')).toBe(true)
  })

  it('rejects a config that uses an unknown useCase', () => {
    const cfg = structuredClone(TENANT_CONFIGS[0]!) as TenantParserConfig
    cfg.scope = { ...cfg.scope, useCase: 'litalerts' }
    writeConfig(tmpRoot, cfg)

    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.some((e) => e.code === 'contract_unknown')).toBe(true)
  })

  it('rejects a config whose recorded golden output does not match parse output', () => {
    const cfg = structuredClone(TENANT_CONFIGS[0]!) as TenantParserConfig
    const rule = cfg.rules[0]!
    const golden = rule.goldens[0]!
    if (golden.kind === 'match') {
      golden.expected = { ...(golden.expected as Record<string, unknown>), brand: 'WRONG' }
    }
    writeConfig(tmpRoot, cfg)

    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.some((e) => e.code === 'golden_failed')).toBe(true)
  })

  it('rejects malformed top-level (wrong configVersion)', () => {
    const dir = join(tmpRoot, 'use-cases', 'pending-purchases', 'parsers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'busted.jsonc'), JSON.stringify({ configVersion: 999 }), 'utf8')
    const { release, errors } = loadParserConfigsFromDir({
      dir: tmpRoot,
      sha: 'x',
      registries: buildRegistries(),
    })
    expect(release).toBeNull()
    expect(errors.some((e) => e.code === 'schema_invalid')).toBe(true)
  })
})
