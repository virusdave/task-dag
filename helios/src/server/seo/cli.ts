// `seo-bundle` CLI — keygen / build (compile + dry-run publish) / publish
// / validate. The Helios-side P1 deliverable (parent EPIC_PLAN §10 P1,
// child epic automation#44; Satisfies: virusdave/top-level#15 Phase: P1).
//
// Run with tsx:
//   tsx src/server/seo/cli.ts keygen
//   tsx src/server/seo/cli.ts build --root /cloud/seo --env nonprod \
//       --config ./seo-bundle-input.json --privkey ./signing.pem
//   tsx src/server/seo/cli.ts publish --root /cloud/seo --env prod \
//       --config ./approved.json --privkey ./signing.pem [--dry-run]
//   tsx src/server/seo/cli.ts validate --root /cloud/seo --env prod \
//       --pubkey ./signing.pub.pem --renderer 0.1.0 [--active 141]
//
// `build` is the P1 dry-run entrypoint: compile + validate + write a
// CANDIDATE pointer to a non-prod path; it never touches the live
// current.json — nothing consumes it yet. `publish` flips the live
// pointer and is operator-only against prod (canon §1: live content).
//
// Signing keys are passed by the operator (file paths); the CLI never
// reads keys from the artifact root.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { generateEd25519Pem, publicKeyPemFromPrivate } from '../lp/signing.js'
import { compileSeoBundle, SeoCompileError, type CompileInput } from './compile.js'
import { loadApprovedFaqSetsForBundle } from './faqBundleSource.js'
import { loadApprovedImageAssetsForBundle } from './imageAssetBundleSource.js'
import { loadApprovedPostsForBundle } from './postBundleSource.js'
import { mergePostSitemaps } from './postSitemapUrls.js'
import { publishSeoBundle, type SeoPublishOptions } from './publish.js'
import { validateSeoBundle } from './validate.js'
import { getPool, closePool } from '../db/pool.js'
import type { SeoEnvironment } from './contracts.js'

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

const ENVIRONMENTS: readonly SeoEnvironment[] = ['prod', 'preview', 'staging', 'nonprod']

function asEnvironment(v: string): SeoEnvironment {
  if ((ENVIRONMENTS as readonly string[]).includes(v)) return v as SeoEnvironment
  throw new Error(`invalid --env '${v}' (expected one of ${ENVIRONMENTS.join(', ')})`)
}

interface BundleConfig {
  sites: CompileInput['sites']
  widgets: CompileInput['widgets']
  content: CompileInput['content']
  policy: CompileInput['policy']
  assets: CompileInput['assets']
  sitemaps: CompileInput['sitemaps']
  disabledContent?: CompileInput['disabledContent']
  minRendererVersion?: string
  automationGitSha?: string
  generatedFrom?: { approval_snapshot_id?: number; seo_policy_version_id?: string }
  previousBundleId?: string
}

function loadConfig(path: string): BundleConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as BundleConfig
}

function compileFromConfig(cfg: BundleConfig) {
  return compileSeoBundle({
    sites: cfg.sites,
    widgets: cfg.widgets,
    content: cfg.content,
    policy: cfg.policy,
    assets: cfg.assets,
    sitemaps: cfg.sitemaps,
    disabledContent: cfg.disabledContent,
  })
}

/**
 * When `--faq-from-db` is passed, replace the config's `content.faq_sets`
 * with the operator-APPROVED FAQ sets from the control-plane DB (verified
 * against the approval ledger by faqBundleSource.ts). Everything else
 * (sites/widgets/policy/assets/sitemaps) still comes from the JSON config.
 * Requires DATABASE_URL to be set. Returns the (possibly unchanged) config.
 */
async function applyFaqFromDb(cfg: BundleConfig, args: Args): Promise<BundleConfig> {
  if (!args.bools.has('faq-from-db')) {
    return cfg
  }
  const faqSets = await loadApprovedFaqSetsForBundle(getPool())
  process.stdout.write(`[faq-from-db] loaded ${faqSets.length} approved FAQ set(s) from DB\n`)
  return {
    ...cfg,
    content: { ...cfg.content, faq_sets: faqSets },
  }
}

/**
 * When `--posts-from-db` is passed, replace the config's `content.posts`
 * with the operator-APPROVED blog posts from the control-plane DB (verified
 * against the approval ledger by postBundleSource.ts). Everything else
 * (sites/widgets/policy/assets/sitemaps) still comes from the JSON config.
 * Requires DATABASE_URL to be set. Returns the (possibly unchanged) config.
 */
async function applyPostsFromDb(cfg: BundleConfig, args: Args): Promise<BundleConfig> {
  if (!args.bools.has('posts-from-db')) {
    return cfg
  }
  const posts = await loadApprovedPostsForBundle(getPool())
  process.stdout.write(`[posts-from-db] loaded ${posts.length} approved post(s) from DB\n`)
  return {
    ...cfg,
    content: { ...cfg.content, posts },
  }
}

/**
 * When `--assets-from-db` is passed, replace the config's top-level
 * `assets` with the operator-APPROVED SEO image assets from the
 * control-plane DB (verified against the approval ledger by
 * imageAssetBundleSource.ts). Everything else (sites/widgets/content/
 * policy/sitemaps) still comes from the JSON config. The compiler's
 * consistency layer additionally enforces that any post that references a
 * hero/og image resolves to one of these approved assets. Requires
 * DATABASE_URL to be set. Returns the (possibly unchanged) config.
 */
async function applyAssetsFromDb(cfg: BundleConfig, args: Args): Promise<BundleConfig> {
  if (!args.bools.has('assets-from-db')) {
    return cfg
  }
  const assets = await loadApprovedImageAssetsForBundle(getPool())
  process.stdout.write(`[assets-from-db] loaded ${assets.length} approved image asset(s) from DB\n`)
  return {
    ...cfg,
    assets,
  }
}

/**
 * When `--sitemaps-from-posts` is passed, regenerate `sitemaps` so every
 * approved, INDEXABLE post in `content.posts` gets a per-post sitemap entry
 * derived from its own canonical_url, merged with the config's STATIC
 * (non-post) sitemap URLs. Runs AFTER posts are loaded so it sees the
 * DB-approved set under `--posts-from-db`. Pure / no DB access. The
 * kill-list (disabledContent) excludes disabled posts from the sitemap
 * while leaving them in content.posts for the pointer kill-list. Returns
 * the (possibly unchanged) config.
 */
function applySitemapsFromPosts(cfg: BundleConfig, args: Args): BundleConfig {
  if (!args.bools.has('sitemaps-from-posts')) {
    return cfg
  }
  const disabledPostIds = new Set(
    (cfg.disabledContent ?? [])
      .filter((d) => d.content_kind === 'post')
      .map((d) => d.content_id),
  )
  const sitemaps = mergePostSitemaps(cfg.sitemaps, cfg.content.posts, { disabledPostIds })
  process.stdout.write(
    `[sitemaps-from-posts] generated ${sitemaps.length} sitemap url(s) ` +
      `(${cfg.content.posts.length} post(s) considered)\n`,
  )
  return { ...cfg, sitemaps }
}

function publishOptsFromConfig(
  cfg: BundleConfig,
  args: Args,
  compiled: ReturnType<typeof compileFromConfig>,
  environment: SeoEnvironment,
  privateKeyPem: string,
  candidateOnly: boolean,
): SeoPublishOptions {
  return {
    compiled,
    privateKeyPem,
    artifactRoot: requireFlag(args, 'root'),
    environment,
    minRendererVersion:
      args.flags.renderer ?? cfg.minRendererVersion ?? 'mss-seo-runtime>=0.1.0',
    automationGitSha: args.flags['git-sha'] ?? cfg.automationGitSha ?? '0000000',
    generatedFrom: {
      seo_policy_version_id: cfg.generatedFrom?.seo_policy_version_id ?? cfg.policy.seo_policy_version_id,
      ...(cfg.generatedFrom?.approval_snapshot_id
        ? { approval_snapshot_id: cfg.generatedFrom.approval_snapshot_id }
        : {}),
    },
    previousBundleId: args.flags.prev ?? cfg.previousBundleId,
    disabledContent: cfg.disabledContent,
    candidateOnly,
  }
}

function cmdKeygen(): number {
  const { publicKeyPem, privateKeyPem } = generateEd25519Pem()
  process.stdout.write(`# ed25519 keypair for SEO bundle signing\n`)
  process.stdout.write(`# Store the PRIVATE key with Helios only (never on /cloud).\n`)
  process.stdout.write(`\n# --- PRIVATE (signing) ---\n${privateKeyPem}`)
  process.stdout.write(`\n# --- PUBLIC (verify; ship to mss) ---\n${publicKeyPem}`)
  return 0
}

async function doPublish(args: Args, candidateOnly: boolean): Promise<number> {
  const environment = asEnvironment(requireFlag(args, 'env'))
  let cfg = await applyFaqFromDb(loadConfig(requireFlag(args, 'config')), args)
  cfg = await applyPostsFromDb(cfg, args)
  cfg = applySitemapsFromPosts(cfg, args)
  cfg = await applyAssetsFromDb(cfg, args)
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')

  const compiled = compileFromConfig(cfg)
  const result = publishSeoBundle(
    publishOptsFromConfig(cfg, args, compiled, environment, privateKeyPem, candidateOnly),
  )

  const tag = result.candidate ? '[dry-run] ' : ''
  process.stdout.write(
    `${tag}published ${result.seoBundleId} v${result.version}\n` +
      `  bundleDir: ${result.bundleDir}\n` +
      `  pointer:   ${result.pointerPath}\n`,
  )

  // Self-validate what we just wrote (a publish that fails its own
  // validation is a bug; surface it loudly and fail).
  const publicKeyPem = publicKeyPemFromPrivate(privateKeyPem)
  const v = validateSeoBundle({
    artifactRoot: requireFlag(args, 'root'),
    pointerPath: result.pointerPath,
    publicKeyPem,
    runningRendererVersion: args.flags['verify-renderer'] ?? '999.0.0',
  })
  if (!v.ok) {
    process.stderr.write(`SELF-VALIDATION FAILED:\n  - ${v.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(`  self-validation: ok\n`)
  return 0
}

function cmdValidate(args: Args): number {
  const publicKeyPem = readFileSync(requireFlag(args, 'pubkey'), 'utf8')
  const result = validateSeoBundle({
    artifactRoot: requireFlag(args, 'root'),
    environment: args.flags.env,
    pointerPath: args.flags.pointer,
    publicKeyPem,
    runningRendererVersion: args.flags.renderer ?? '0.0.0',
    activeVersion: args.flags.active ? Number.parseInt(args.flags.active, 10) : undefined,
  })
  if (result.ok) {
    process.stdout.write(`VALID ${result.seoBundleId} v${result.version}\n`)
    return 0
  }
  process.stderr.write(
    `INVALID${result.seoBundleId ? ` ${result.seoBundleId}` : ''}:\n  - ${result.errors.join('\n  - ')}\n`,
  )
  return 1
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const command = args._[0]
  try {
    switch (command) {
      case 'keygen':
        return cmdKeygen()
      case 'build':
        // P1 dry-run: compile + write a candidate pointer only. With
        // `--faq-from-db` the FAQ content comes from approved DB rows.
        return await doPublish(args, true)
      case 'publish':
        return await doPublish(args, args.bools.has('dry-run'))
      case 'validate':
        return cmdValidate(args)
      default:
        process.stderr.write('usage: seo-bundle <keygen|build|publish|validate> [options]\n')
        return 2
    }
  } catch (e) {
    if (e instanceof SeoCompileError) {
      process.stderr.write(`${e.message}\n`)
      return 1
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  } finally {
    // The DB pool is only opened by the --faq-from-db / --posts-from-db /
    // --assets-from-db paths; closing an unopened pool is a no-op, so this
    // is always safe.
    if (
      args.bools.has('faq-from-db') ||
      args.bools.has('posts-from-db') ||
      args.bools.has('assets-from-db')
    ) {
      await closePool()
    }
  }
}

/* istanbul ignore next — entrypoint guard */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    },
  )
}
