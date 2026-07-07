// Migration artifact resolver + digest (automation#62, leaf 3).
//
// The pending-migrations "Apply Now" flow (see
// docs/helios/pending-migrations-admin-apply/DESIGN.md) shells out to
// `psql -f <file>` against the live DB. Because the artifact that runs is
// prod-schema-mutating, canon rules/DB_PERFORMANCE.md + the design's safety
// item 4 require that the worker run the **exact reviewed artifact** and never
// ad-hoc SQL, and that the path be locked down (allowlisted id, filename
// pattern, realpath containment, and every `\i`/`\ir` include verified inside
// the deployed artifact root). This module is the fail-closed resolver +
// digester for that; it does NOT execute anything (that is leaf 4).
//
// Deployment layout: the migration/schema `.sql` files are shipped into the
// build output next to this compiled module by the `copy:non-ts-server-assets`
// build step. `tsc` (rootDir=src, outDir=dist/server) compiles
// src/server/db/migrationArtifacts.ts -> dist/server/server/db/
// migrationArtifacts.js, and the copy step places the artifacts at
// dist/server/server/db/{migrations,schema}/, so resolving relative to this
// module's own directory (import.meta.url) finds the deployed artifacts and
// preserves the `\ir ../schema/...` relative layout. We deliberately resolve
// from the deployed dist tree — never from src/ — so the running unit only ever
// applies what shipped in its own bundle.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIGRATION_SENTINEL_IDS } from './pendingMigrations.js'

/** A migrationId is the sentinel key, e.g. "097_litalerts_parse_feedback". */
const MIGRATION_ID_PATTERN = /^\d{3}_[a-z0-9_]+$/
/** The committed artifact filename, e.g. "097_litalerts_parse_feedback.sql". */
const MIGRATION_FILENAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/

// psql client meta-commands that pull in another file. `\i` / `\include`
// resolve relative to psql's cwd; `\ir` / `\include_relative` resolve relative
// to the directory of the script currently being read. We model both exactly
// (the worker runs psql with cwd = the migration directory).
const INCLUDE_COMMAND_PATTERN =
  /^[ \t]*\\(include_relative|include|ir|i)\b[ \t]*(.*)$/
// Conditional psql meta-commands. Our current corpus uses none; if a migration
// ever gains one, its interaction with includes is non-trivial, so we fail
// closed rather than silently mis-model the artifact.
const CONDITIONAL_COMMAND_PATTERN = /^[ \t]*\\(if|elif|else|endif)\b/
// Include argument: a single bare relative POSIX-ish path. Anything with
// whitespace, quoting, shell/`:`variable expansion, `~`, backslashes, or an
// absolute lead is rejected (the corpus only uses `../schema/foo.sql`).
const SAFE_INCLUDE_ARG_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

export type MigrationArtifactErrorCode =
  | 'unknown-migration-id'
  | 'invalid-migration-id'
  | 'invalid-filename'
  | 'not-a-regular-file'
  | 'path-escape'
  | 'missing-include'
  | 'unsafe-include-arg'
  | 'unsupported-meta-command'
  | 'include-cycle'

/**
 * A fail-closed rejection while resolving a migration artifact. Callers (the
 * apply endpoint + worker) surface `code` so an operator sees *why* an artifact
 * was refused rather than a bare stack trace.
 */
export class MigrationArtifactError extends Error {
  readonly code: MigrationArtifactErrorCode
  constructor(code: MigrationArtifactErrorCode, message: string) {
    super(message)
    this.name = 'MigrationArtifactError'
    this.code = code
  }
}

export interface ResolvedArtifactFile {
  /** Absolute, realpath-resolved location on disk. */
  readonly absPath: string
  /** POSIX path relative to the DB artifact root (stable across deploys). */
  readonly relPath: string
}

export interface ResolvedMigrationArtifact {
  readonly migrationId: string
  /** The main migration file (`migrations/NNN_*.sql`). */
  readonly main: ResolvedArtifactFile
  /**
   * The full transitive `\i`/`\ir` include closure (schema files), sorted by
   * relPath. Excludes the main file.
   */
  readonly includes: readonly ResolvedArtifactFile[]
  /**
   * sha256 over the reviewed unit: the main file plus its entire include
   * closure. A later edit to a shared schema include changes this digest, so a
   * stale Oracle blessing bound to the old digest no longer matches.
   */
  readonly sha256: string
  /** The migrations/ root the main file must live under. */
  readonly migrationsRoot: string
  /** The schema/ root every include must live under. */
  readonly schemaRoot: string
}

export interface ResolveOptions {
  /**
   * The deployed DB artifact root that contains `migrations/` and `schema/`.
   * Defaults to this module's own directory (the dist layout). Tests point it
   * at a fixture tree or at src/server/db.
   */
  readonly dbRoot?: string
  /**
   * The set of migrationIds that are allowed to be resolved. Defaults to the
   * live sentinel registry. Tests override it for fixtures.
   */
  readonly allowedMigrationIds?: ReadonlySet<string>
}

/** The DB artifact root as shipped alongside this compiled module. */
export function defaultDbArtifactRoot(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

function realDir(dir: string): string {
  // Resolve symlinks on the root itself so containment comparisons are made
  // against the canonical path.
  return fs.realpathSync(dir)
}

/**
 * Realpath a candidate file and assert it is a regular (non-symlink) file
 * contained under `root`. Rejects symlinks *before* realpath (via lstat) so a
 * symlinked artifact cannot make the resolver's view diverge from psql's.
 */
function resolveContainedFile(
  root: string,
  candidate: string,
  escapeMessage: string,
): string {
  let lstat: fs.Stats
  try {
    lstat = fs.lstatSync(candidate)
  } catch {
    throw new MigrationArtifactError(
      'missing-include',
      `Artifact file does not exist: ${candidate}`,
    )
  }
  if (lstat.isSymbolicLink()) {
    throw new MigrationArtifactError(
      'not-a-regular-file',
      `Artifact file is a symlink (refused): ${candidate}`,
    )
  }
  if (!lstat.isFile()) {
    throw new MigrationArtifactError(
      'not-a-regular-file',
      `Artifact path is not a regular file: ${candidate}`,
    )
  }
  const real = fs.realpathSync(candidate)
  const rel = path.relative(root, real)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new MigrationArtifactError('path-escape', `${escapeMessage}: ${candidate}`)
  }
  return real
}

/**
 * Parse the include directives out of one artifact file. Returns the resolved
 * absolute paths of directly-included files. `\ir` resolves relative to
 * `fileDir`; `\i` resolves relative to `psqlCwd` (the migration directory).
 */
function parseIncludes(
  fileAbsPath: string,
  contents: Buffer,
  fileDir: string,
  psqlCwd: string,
  schemaRoot: string,
): string[] {
  const text = contents.toString('utf8')
  // Split on \n and strip a trailing \r so CRLF files parse; the digest still
  // hashes the raw bytes elsewhere.
  const lines = text.split('\n')
  const resolved: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (CONDITIONAL_COMMAND_PATTERN.test(line)) {
      throw new MigrationArtifactError(
        'unsupported-meta-command',
        `Conditional psql meta-command is not supported in a resolvable artifact (${fileAbsPath}): ${line.trim()}`,
      )
    }
    const match = INCLUDE_COMMAND_PATTERN.exec(line)
    if (!match) {
      continue
    }
    const command = match[1]
    const arg = match[2]?.trim() ?? ''
    if (arg === '' || !SAFE_INCLUDE_ARG_PATTERN.test(arg)) {
      throw new MigrationArtifactError(
        'unsafe-include-arg',
        `Unsafe/unsupported \\${command} include argument in ${fileAbsPath}: ${JSON.stringify(arg)}`,
      )
    }
    const isRelative = command === 'ir' || command === 'include_relative'
    const base = isRelative ? fileDir : psqlCwd
    const candidate = path.resolve(base, arg)
    const real = resolveContainedFile(
      schemaRoot,
      candidate,
      `\\${command} include escapes the schema artifact root`,
    )
    resolved.push(real)
  }
  return resolved
}

/**
 * Resolve, validate, and digest the exact artifact closure for a migrationId.
 * Fail-closed: any allowlist / filename / containment / include violation
 * throws a {@link MigrationArtifactError}. Does not execute anything.
 */
export function resolveMigrationArtifact(
  migrationId: string,
  options: ResolveOptions = {},
): ResolvedMigrationArtifact {
  const allowed = options.allowedMigrationIds ?? MIGRATION_SENTINEL_IDS
  const dbRoot = realDir(options.dbRoot ?? defaultDbArtifactRoot())
  const migrationsRoot = realDir(path.join(dbRoot, 'migrations'))
  const schemaRoot = realDir(path.join(dbRoot, 'schema'))

  if (!MIGRATION_ID_PATTERN.test(migrationId)) {
    throw new MigrationArtifactError(
      'invalid-migration-id',
      `migrationId is not a valid identifier: ${JSON.stringify(migrationId)}`,
    )
  }
  if (!allowed.has(migrationId)) {
    throw new MigrationArtifactError(
      'unknown-migration-id',
      `migrationId is not in the migration registry: ${migrationId}`,
    )
  }

  const filename = `${migrationId}.sql`
  if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
    throw new MigrationArtifactError(
      'invalid-filename',
      `Derived filename is not a valid migration artifact name: ${filename}`,
    )
  }

  const mainCandidate = path.resolve(migrationsRoot, filename)
  const mainAbs = resolveContainedFile(
    migrationsRoot,
    mainCandidate,
    'Main migration file escapes the migrations artifact root',
  )

  // Transitive DFS over the include closure. psql runs the apply with cwd set
  // to the migration directory, so `\i` (cwd-relative) resolves there.
  const psqlCwd = migrationsRoot
  const visited = new Set<string>([mainAbs])
  const onStack = new Set<string>([mainAbs])
  const includeAbsPaths = new Set<string>()

  const walk = (fileAbsPath: string): void => {
    const contents = fs.readFileSync(fileAbsPath)
    const fileDir = path.dirname(fileAbsPath)
    const directIncludes = parseIncludes(
      fileAbsPath,
      contents,
      fileDir,
      psqlCwd,
      schemaRoot,
    )
    for (const includeAbs of directIncludes) {
      if (onStack.has(includeAbs)) {
        throw new MigrationArtifactError(
          'include-cycle',
          `Include cycle detected reaching ${includeAbs}`,
        )
      }
      includeAbsPaths.add(includeAbs)
      if (visited.has(includeAbs)) {
        continue
      }
      visited.add(includeAbs)
      onStack.add(includeAbs)
      walk(includeAbs)
      onStack.delete(includeAbs)
    }
  }
  walk(mainAbs)

  const mainRel = toPosix(path.relative(dbRoot, mainAbs))
  const includes: ResolvedArtifactFile[] = [...includeAbsPaths]
    .map((absPath) => ({ absPath, relPath: toPosix(path.relative(dbRoot, absPath)) }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const sha256 = digestClosure([
    { absPath: mainAbs, relPath: mainRel },
    ...includes,
  ])

  return {
    migrationId,
    main: { absPath: mainAbs, relPath: mainRel },
    includes,
    sha256,
    migrationsRoot,
    schemaRoot,
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Deterministic sha256 over the reviewed unit. Files are sorted by relPath and
 * framed with explicit byte lengths so no concatenation ambiguity exists, and
 * the raw file bytes are hashed exactly as deployed (no CRLF/whitespace
 * normalisation).
 */
function digestClosure(files: readonly ResolvedArtifactFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  )
  const hash = createHash('sha256')
  for (const file of sorted) {
    const content = fs.readFileSync(file.absPath)
    const relBuf = Buffer.from(file.relPath, 'utf8')
    hash.update(`${relBuf.length}\0`)
    hash.update(relBuf)
    hash.update(`\0${content.length}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}
