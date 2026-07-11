import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MigrationArtifactError,
  readMigrationArtifactForReview,
  resolveMigrationArtifact,
} from './migrationArtifacts.js'
import { MIGRATION_SENTINEL_IDS } from './pendingMigrations.js'

// ============================================================================
// Fixture-based tests for the fail-closed migration artifact resolver + digest.
// No prod DB, no real psql — only synthetic SQL files in a temp tree (plus one
// pass over the real committed corpus to prove every shipped migration with
// includes resolves).
// ============================================================================

const ID = '099_fixture_migration' // matches ^\d{3}_[a-z0-9_]+$
const ALLOWED = new Set<string>([ID, '100_second', '101_cyclic_a', '102_cyclic_b'])

let root: string
let migrationsRoot: string
let schemaRoot: string

function write(rel: string, contents: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helios-migart-'))
  migrationsRoot = join(root, 'migrations')
  schemaRoot = join(root, 'schema')
  mkdirSync(migrationsRoot, { recursive: true })
  mkdirSync(schemaRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function resolve(id: string) {
  return resolveMigrationArtifact(id, { dbRoot: root, allowedMigrationIds: ALLOWED })
}

function review(id: string) {
  return readMigrationArtifactForReview(id, { dbRoot: root, allowedMigrationIds: ALLOWED })
}

/**
 * Assert that `fn` throws a MigrationArtifactError with the given `code`.
 * (vitest's `toThrow` only matches the message/class, not arbitrary props.)
 */
function expectRejects(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected a throw with code ${code}`).toBeInstanceOf(
    MigrationArtifactError,
  )
  expect((thrown as MigrationArtifactError).code).toBe(code)
}

describe('resolveMigrationArtifact — happy paths', () => {
  it('resolves a migration with an \\ir (relative) include', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(
      `migrations/${ID}.sql`,
      'begin;\n\\ir ../schema/thing.sql\ncommit;\n',
    )
    const artifact = resolve(ID)
    expect(artifact.migrationId).toBe(ID)
    expect(artifact.main.relPath).toBe(`migrations/${ID}.sql`)
    expect(artifact.includes.map((f) => f.relPath)).toEqual(['schema/thing.sql'])
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves a migration with an \\i (cwd-relative) include', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, '\\i ../schema/thing.sql\n')
    const artifact = resolve(ID)
    expect(artifact.includes.map((f) => f.relPath)).toEqual(['schema/thing.sql'])
  })

  it('resolves a nested include closure and sorts by relPath', () => {
    write('schema/a.sql', '\\ir b.sql\ncreate table if not exists a ();\n')
    write('schema/b.sql', 'create table if not exists b ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/a.sql\n')
    const artifact = resolve(ID)
    expect(artifact.includes.map((f) => f.relPath)).toEqual([
      'schema/a.sql',
      'schema/b.sql',
    ])
  })

  it('does not treat \\set / \\echo / comments / SQL text as includes', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(
      `migrations/${ID}.sql`,
      [
        `\\set ON_ERROR_STOP on`,
        `\\echo 'this mentions \\i ../schema/evil.sql inside a string'`,
        `-- a comment about \\i ../schema/evil.sql`,
        `select '\\i ../schema/evil.sql' as not_an_include;`,
        `\\ir ../schema/thing.sql`,
      ].join('\n') + '\n',
    )
    const artifact = resolve(ID)
    expect(artifact.includes.map((f) => f.relPath)).toEqual(['schema/thing.sql'])
  })

  it('parses includes across CRLF line endings but digests raw bytes', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/thing.sql\r\ncommit;\r\n')
    const artifact = resolve(ID)
    expect(artifact.includes.map((f) => f.relPath)).toEqual(['schema/thing.sql'])

    // Re-write the same logical content with LF endings: raw bytes differ, so
    // the digest must change (no CRLF normalisation).
    const lfDigest = artifact.sha256
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/thing.sql\ncommit;\n')
    expect(resolve(ID).sha256).not.toBe(lfDigest)
  })
})

describe('digest sensitivity', () => {
  it('changes when the main migration content changes', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/thing.sql\n')
    const before = resolve(ID).sha256
    write(`migrations/${ID}.sql`, '\\ir ../schema/thing.sql\n-- extra\n')
    expect(resolve(ID).sha256).not.toBe(before)
  })

  it('changes when an included schema file content changes', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/thing.sql\n')
    const before = resolve(ID).sha256
    write('schema/thing.sql', 'create table if not exists thing (id int);\n')
    expect(resolve(ID).sha256).not.toBe(before)
  })
})

describe('readMigrationArtifactForReview', () => {
  it('returns the main file then sorted include files with exact text and digest', () => {
    write('schema/z.sql', 'create table z ();\n')
    write('schema/a.sql', 'create table a ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/z.sql\n\\ir ../schema/a.sql\n')

    const result = review(ID)
    expect(result.sha256).toBe(resolve(ID).sha256)
    expect(result.files.map(({ role, relPath }) => ({ role, relPath }))).toEqual([
      { role: 'main', relPath: `migrations/${ID}.sql` },
      { role: 'include', relPath: 'schema/a.sql' },
      { role: 'include', relPath: 'schema/z.sql' },
    ])
    expect(result.files[1]?.text).toBe('create table a ();\n')
    expect(result.totalBytes).toBe(result.files.reduce((sum, file) => sum + file.byteLength, 0))
  })

  it('parses and hashes one captured main-file version when the file changes mid-read', () => {
    write('schema/a.sql', 'create table a ();\n')
    write('schema/b.sql', 'create table b ();\n')
    const mainPath = join(migrationsRoot, `${ID}.sql`)
    write(`migrations/${ID}.sql`, '\\ir ../schema/a.sql\n')
    const originalDigest = resolve(ID).sha256
    let mainReads = 0
    const result = readMigrationArtifactForReview(ID, {
      dbRoot: root,
      allowedMigrationIds: ALLOWED,
      readFile: (filePath) => {
        const content = readFileSync(filePath)
        if (filePath === mainPath) {
          mainReads++
          write(`migrations/${ID}.sql`, '\\ir ../schema/b.sql\n')
        }
        return content
      },
    })

    expect(result.files.map((file) => file.relPath)).toEqual([
      `migrations/${ID}.sql`,
      'schema/a.sql',
    ])
    expect(result.files[0]?.text).toBe('\\ir ../schema/a.sql\n')
    expect(result.sha256).toBe(originalDigest)
    expect(mainReads).toBe(1)
  })

  it('rejects invalid UTF-8 rather than displaying replacement characters', () => {
    const abs = join(migrationsRoot, `${ID}.sql`)
    writeFileSync(abs, Buffer.from([0xff, 0xfe]))
    expectRejects(() => review(ID), 'review-artifact-invalid-utf8')
  })

  it('rejects a review payload over one MiB', () => {
    write(`migrations/${ID}.sql`, 'x'.repeat(1024 * 1024 + 1))
    expectRejects(() => review(ID), 'review-artifact-too-large')
  })
})

describe('resolveMigrationArtifact — fail closed', () => {
  it('rejects an unregistered migrationId', () => {
    write(`migrations/999_unregistered.sql`, 'select 1;\n')
    expectRejects(() =>
      resolveMigrationArtifact('999_unregistered', {
        dbRoot: root,
        allowedMigrationIds: ALLOWED,
      }), 'unknown-migration-id')
  })

  it('rejects a syntactically invalid migrationId', () => {
    expectRejects(() => resolve('../../etc/passwd'), 'invalid-migration-id')
    expectRejects(() => resolve('97_bad'), 'invalid-migration-id')
    expectRejects(() => resolve('099_Bad_Caps'), 'invalid-migration-id')
  })

  it('rejects a missing main migration file', () => {
    expectRejects(() => resolve(ID), 'missing-include')
  })

  it('rejects a missing include', () => {
    write(`migrations/${ID}.sql`, '\\ir ../schema/does_not_exist.sql\n')
    expectRejects(() => resolve(ID), 'missing-include')
  })

  it('rejects an absolute include path', () => {
    write(`migrations/${ID}.sql`, '\\i /etc/passwd\n')
    expectRejects(() => resolve(ID), 'unsafe-include-arg')
  })

  it('rejects a ../ include that escapes the schema root', () => {
    write('secret.sql', 'create table if not exists secret ();\n')
    write(`migrations/${ID}.sql`, '\\ir ../secret.sql\n')
    expectRejects(() => resolve(ID), 'path-escape')
  })

  it('rejects a quoted include argument', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(`migrations/${ID}.sql`, `\\ir '../schema/thing.sql'\n`)
    expectRejects(() => resolve(ID), 'unsafe-include-arg')
  })

  it('rejects a backtick / variable include argument', () => {
    write(`migrations/${ID}.sql`, '\\i `echo pwned`\n')
    expectRejects(() => resolve(ID), 'unsafe-include-arg')
    write(`migrations/${ID}.sql`, '\\i :some_var\n')
    expectRejects(() => resolve(ID), 'unsafe-include-arg')
  })

  it('rejects a symlinked include (no realpath divergence with psql)', () => {
    write('outside.sql', 'create table if not exists outside ();\n')
    // schema/link.sql -> ../outside.sql (escapes schema root via symlink)
    symlinkSync(join(root, 'outside.sql'), join(schemaRoot, 'link.sql'))
    write(`migrations/${ID}.sql`, '\\ir ../schema/link.sql\n')
    expectRejects(() => resolve(ID), 'not-a-regular-file')
  })

  it('rejects a symlinked main migration file', () => {
    write('outside_main.sql', 'select 1;\n')
    symlinkSync(join(root, 'outside_main.sql'), join(migrationsRoot, `${ID}.sql`))
    expectRejects(() => resolve(ID), 'not-a-regular-file')
  })

  it('rejects an unsupported conditional meta-command', () => {
    write('schema/thing.sql', 'create table if not exists thing ();\n')
    write(
      `migrations/${ID}.sql`,
      '\\if :something\n\\ir ../schema/thing.sql\n\\endif\n',
    )
    expectRejects(() => resolve(ID), 'unsupported-meta-command')
  })

  it('detects an include cycle', () => {
    write('schema/x.sql', '\\ir y.sql\n')
    write('schema/y.sql', '\\ir x.sql\n')
    write(`migrations/${ID}.sql`, '\\ir ../schema/x.sql\n')
    expectRejects(() => resolve(ID), 'include-cycle')
  })
})

describe('the real committed migration corpus', () => {
  // Point the resolver at src/server/db (this test file lives in that dir), so
  // every shipped migration with an include closure resolves + digests without
  // a path escape. Guards the corpus itself against a stray unsafe include or a
  // renamed schema file breaking the apply flow.
  const dbRoot = dirname(fileURLToPath(import.meta.url))

  it('resolves every registered migration that has a committed .sql file', () => {
    let resolvedCount = 0
    for (const id of MIGRATION_SENTINEL_IDS) {
      let artifact
      try {
        artifact = resolveMigrationArtifact(id, { dbRoot })
      } catch (error) {
        // A registry entry whose .sql file predates this convention (or was
        // pruned) is allowed to be absent; anything else is a real failure.
        if (error instanceof MigrationArtifactError && error.code === 'missing-include') {
          continue
        }
        throw new Error(`migration ${id} failed to resolve: ${String(error)}`)
      }
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
      resolvedCount++
    }
    // Sanity: we actually exercised a meaningful chunk of the corpus.
    expect(resolvedCount).toBeGreaterThan(20)
  })

  it('can display every registered migration that has a committed .sql file', () => {
    let reviewableCount = 0
    for (const id of MIGRATION_SENTINEL_IDS) {
      try {
        const artifact = readMigrationArtifactForReview(id, { dbRoot })
        expect(artifact.files[0]?.role).toBe('main')
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
        reviewableCount++
      } catch (error) {
        if (error instanceof MigrationArtifactError && error.code === 'missing-include') {
          continue
        }
        throw new Error(`migration ${id} cannot be displayed: ${String(error)}`)
      }
    }
    expect(reviewableCount).toBeGreaterThan(20)
  })

  it('resolves 097_litalerts_parse_feedback and its schema include', () => {
    const artifact = resolveMigrationArtifact('097_litalerts_parse_feedback', {
      dbRoot,
    })
    expect(artifact.main.relPath).toBe(
      'migrations/097_litalerts_parse_feedback.sql',
    )
    expect(artifact.includes.map((f) => f.relPath)).toContain(
      'schema/litalertsParseFeedback.sql',
    )
  })
})
