// `branding-opaque-manifest` CLI — build / publish / validate the FB-US
// branding `literal-slug → opaque-ref` manifest (Helios single producer;
// parent EPIC_PLAN top-level#19 P1-prereq, automation#48).
//
// Run with tsx (the dedicated Helios read-only DB URL must be provisioned; for
// a PRODUCTION manifest FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET must be the REAL
// secret — the non-production fallback would 308 live Google-Ads URLs to 404):
//
//   tsx src/server/branding/cli.ts build [--env prod] [--out map.json]
//   tsx src/server/branding/cli.ts publish --root /cloud/lp --env prod \
//       --privkey ./signing.pem [--git-sha <sha>] [--prev <bom_id>]
//   tsx src/server/branding/cli.ts validate --root /cloud/lp --env prod \
//       --pubkey ./signing.pub.pem
//
// `build` is a read-only preview (no signing, no artifact write): it prints
// the deterministic mapping for operator inspection / the Ads-Editor CSV.
// `publish` writes the immutable signed manifest + atomically swaps the
// signed `current.json` pointer; it only changes ad-redirect behavior once
// mss ingests it under the operator-gated rollout (parent §5 P1/P4).
//
// Signing keys are passed by the operator (file paths); never read from the
// artifact root.

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { pageDave } from '../../worker/runtime/pageDave.js'
import { readRequiredReadOnlyDatabaseUrl } from '../../shared/config/runtimeEnv.js'
import { closePool, getPool } from '../db/pool.js'
import { publicKeyPemFromPrivate } from '../lp/signing.js'
import type { LpEnvironment } from '../lp/publish.js'
import { fetchBrandingPresenceRows } from './db.js'
import {
  buildBrandingOpaqueManifest,
  type BrandingManifestBuildResult,
  type BrandingSlugCollision,
} from './manifest.js'
import { publishBrandingOpaqueManifest, validateBrandingOpaqueManifest } from './publish.js'
import {
  requireProductionBrandingSecret,
  resolveBrandingOpaqueSecret,
  type ResolvedBrandingSecret,
} from './secret.js'

interface Args {
  readonly _: string[]
  readonly flags: Record<string, string>
  readonly bools: Set<string>
}

function parseArgs(argv: string[]): Args {
  const _: string[] = []
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        bools.add(key)
      } else {
        flags[key] = next
        i++
      }
    } else {
      _.push(a)
    }
  }
  return { _, flags, bools }
}

function requireFlag(args: Args, name: string): string {
  const v = args.flags[name]
  if (v === undefined) throw new Error(`missing required --${name}`)
  return v
}

const ENVIRONMENTS: readonly LpEnvironment[] = ['prod', 'preview', 'staging', 'nonprod']

function asEnvironment(v: string): LpEnvironment {
  if ((ENVIRONMENTS as readonly string[]).includes(v)) return v as LpEnvironment
  throw new Error(`invalid --env '${v}' (expected one of ${ENVIRONMENTS.join(', ')})`)
}

/** Resolve the secret, requiring the real prod one when targeting prod. */
function resolveSecretForEnv(environment: LpEnvironment): ResolvedBrandingSecret {
  return environment === 'prod' ? requireProductionBrandingSecret() : resolveBrandingOpaqueSecret()
}

function summarize(result: BrandingManifestBuildResult): string {
  const s = result.summary
  return (
    `  secret_source: ${result.secretSource}\n` +
    `  included brands: ${String(s.includedBrands)}\n` +
    `  presence rows considered: ${String(s.presenceRowsConsidered)}\n` +
    `  skipped (non-FB-US site): ${String(s.skippedNotFbUsSite)}\n` +
    `  skipped (empty name): ${String(s.skippedEmptyName)}\n` +
    `  skipped (retired/DEAD name): ${String(s.skippedRetiredName)}\n` +
    `  skipped (empty slug): ${String(s.skippedEmptySlug)}\n` +
    `  skipped (never for sale): ${String(s.skippedNotForSale)}\n` +
    `  merged duplicate-slug rows: ${String(s.mergedDuplicateSlugRows)}\n` +
    `  slug collisions resolved: ${String(s.slugCollisionGroups)} ` +
    `(${String(s.ambiguousCollisionGroups)} ambiguous, ${String(s.droppedCollisionBrands)} brand(s) dropped)\n`
  )
}

// The single live collision (bronx/dr-jekyll-and-mr-high) is known and
// benign (one stale duplicate skipped in favour of the live brand). The
// operator wants a page only when collisions grow beyond that one OR a
// genuinely ambiguous group appears (no single obvious winner).
const KNOWN_BENIGN_COLLISION_GROUPS = 1

function isoOrNull(value: Date | null): string {
  return value === null ? 'never' : value.toISOString()
}

/** Human-readable, greppable dump of one resolved collision. */
function formatCollision(collision: BrandingSlugCollision): string {
  const lines = [
    `  [${collision.resolution}] ${collision.siteKey}/${collision.literalSlug} ` +
      `→ brand ${String(collision.winnerBrandId)}`,
  ]
  for (const b of collision.brands) {
    lines.push(
      `      ${b.selected ? '✓ keep' : '✗ drop'} brand ${String(b.sweedBrandId)} "${b.brandName}" ` +
        `(live=${String(b.brandWideActive)}, forSale=${String(b.forSaleVariantCount)}, ` +
        `lastForSale=${isoOrNull(b.lastForSaleObservedAt)})`,
    )
  }
  return lines.join('\n')
}

/**
 * Print every resolved slug collision (always, loudly, to stderr) and, when
 * the collision picture is abnormal (more than the one known benign group,
 * or any ambiguous group), page the operator. Best-effort: a paging failure
 * must never break a read-only build or an otherwise-successful publish.
 */
async function reportCollisions(result: BrandingManifestBuildResult, command: string): Promise<void> {
  const { collisions } = result
  if (collisions.length === 0) return

  process.stderr.write(`\n[branding] ${String(collisions.length)} slug collision(s) resolved:\n`)
  for (const c of collisions) process.stderr.write(`${formatCollision(c)}\n`)

  const abnormal =
    collisions.length > KNOWN_BENIGN_COLLISION_GROUPS || result.summary.ambiguousCollisionGroups > 0
  if (!abnormal) {
    process.stderr.write(`[branding] (within the single tolerated benign collision count; not paging)\n`)
    return
  }

  const summaryLine =
    `branding manifest ${command}: ${String(collisions.length)} slug collision(s), ` +
    `${String(result.summary.ambiguousCollisionGroups)} ambiguous — expanded beyond the known one.`
  process.stderr.write(`\n‼️  OPERATOR ACTION REQUIRED: ${summaryLine}\n`)
  process.stderr.write(`    Resolve via the mss overlay-fixup migration into Helios (automation#48).\n`)
  try {
    await pageDave(
      `${summaryLine}\n\n` +
        collisions.map((c) => formatCollision(c)).join('\n\n') +
        `\n\nSee https://github.com/FreshlyBakedNYC/automation/issues/48`,
      { priority: 4, title: 'FB-US branding slug collisions expanded' },
    )
    process.stderr.write(`[branding] paged operator (page-dave).\n`)
  } catch (e) {
    process.stderr.write(`[branding] WARNING: failed to page operator: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

async function buildFromDb(environment: LpEnvironment): Promise<BrandingManifestBuildResult> {
  process.env.DATABASE_URL = readRequiredReadOnlyDatabaseUrl()
  const secret = resolveSecretForEnv(environment)
  const rows = await fetchBrandingPresenceRows(getPool())
  return buildBrandingOpaqueManifest(rows, { secret: secret.secret, secretSource: secret.source })
}

async function cmdBuild(args: Args): Promise<number> {
  const environment = asEnvironment(args.flags.env ?? 'nonprod')
  const result = await buildFromDb(environment)
  const out = JSON.stringify({ scheme: result.scheme, secret_source: result.secretSource, entries: result.entries }, null, 2)
  if (args.flags.out) {
    writeFileSync(args.flags.out, `${out}\n`)
    process.stdout.write(`[build] wrote ${String(result.entries.length)} entries to ${args.flags.out}\n`)
  } else {
    process.stdout.write(`${out}\n`)
  }
  process.stdout.write(summarize(result))
  await reportCollisions(result, 'build')
  return 0
}

async function cmdPublish(args: Args): Promise<number> {
  const root = requireFlag(args, 'root')
  const environment = asEnvironment(requireFlag(args, 'env'))
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')

  const buildResult = await buildFromDb(environment)
  const result = publishBrandingOpaqueManifest({
    buildResult,
    privateKeyPem,
    artifactRoot: root,
    environment,
    automationGitSha: args.flags['git-sha'] ?? '0000000',
    previousManifestId: args.flags.prev,
    version: args.flags.version ? Number.parseInt(args.flags.version, 10) : undefined,
  })

  process.stdout.write(
    `published ${result.manifestId} v${String(result.version)} (${String(result.entryCount)} entries)\n` +
      `  manifestDir: ${result.manifestDir}\n` +
      `  pointer:     ${result.pointerPath}\n`,
  )
  process.stdout.write(summarize(buildResult))
  await reportCollisions(buildResult, 'publish')

  // Self-validate what we just wrote.
  const v = validateBrandingOpaqueManifest({
    artifactRoot: root,
    pointerPath: result.pointerPath,
    publicKeyPem: publicKeyPemFromPrivate(privateKeyPem),
  })
  if (!v.ok) {
    process.stderr.write(`SELF-VALIDATION FAILED:\n  - ${v.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(`  self-validation: ok\n`)
  return 0
}

function cmdValidate(args: Args): number {
  const root = requireFlag(args, 'root')
  const publicKeyPem = readFileSync(requireFlag(args, 'pubkey'), 'utf8')
  const result = validateBrandingOpaqueManifest({
    artifactRoot: root,
    environment: args.flags.env,
    pointerPath: args.flags.pointer,
    publicKeyPem,
  })
  if (result.ok) {
    process.stdout.write(`VALID ${result.manifestId ?? ''} v${String(result.version ?? 0)} (${String(result.entryCount ?? 0)} entries)\n`)
    return 0
  }
  process.stderr.write(`INVALID${result.manifestId ? ` ${result.manifestId}` : ''}:\n  - ${result.errors.join('\n  - ')}\n`)
  return 1
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args._[0]
  try {
    switch (command) {
      case 'build':
        return await cmdBuild(args)
      case 'publish':
        return await cmdPublish(args)
      case 'validate':
        return cmdValidate(args)
      default:
        process.stderr.write('usage: branding-opaque-manifest <build|publish|validate> [options]\n')
        return 2
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  } finally {
    await closePool().catch(() => {})
  }
}

/* istanbul ignore next — entrypoint guard */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code))
}
