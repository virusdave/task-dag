// `helios lp-bundle` CLI — keygen / compile+publish (incl. --dry-run) /
// validate. The Helios-side P1 deliverable (parent EPIC_PLAN §10 P1 +
// the automation#42 "Validation CLI" item).
//
// Run with tsx:
//   tsx src/server/lp/cli.ts keygen
//   tsx src/server/lp/cli.ts publish --root /cloud/lp --env prod \
//       --config ./bundle-input.json --privkey ./signing.pem [--dry-run]
//   tsx src/server/lp/cli.ts publish-candidate --root /cloud/lp --env prod \
//       --config ./approved-content.json --privkey ./signing.pem \
//       --pubkey ./signing.pub.pem --verify-renderer 0.4.0 \
//       [--enable-crossrepo-producer]
//   tsx src/server/lp/cli.ts promote-candidate --root /cloud/lp --env prod \
//       --privkey ./signing.pem --pubkey ./signing.pub.pem --renderer 0.4.0
//   tsx src/server/lp/cli.ts rollback --root /cloud/lp --env prod \
//       --to-bundle <bundle_id> --privkey ./signing.pem \
//       --pubkey ./signing.pub.pem --renderer 0.4.0
//   tsx src/server/lp/cli.ts validate --root /cloud/lp --env prod \
//       --pubkey ./signing.pub.pem --renderer 0.4.0 [--active 4411]
//
// Branding-opaque parity (automation#48 P3): when a bundle emits a
// `branding` SLUG (a kill-list slug for purpose `branding`, or a
// branding-family policy `cluster_slug`), pass `--branding-pubkey <pem>`
// (and optionally `--branding-env` / `--branding-pointer`) to any of
// publish / publish-candidate / promote-candidate / rollback / validate.
// The CLI then loads the published branding manifest from
// `<root>/branding-opaque/<env>/current.json`, fail-closed, and the
// compile/validate parity check refuses to sign a branding ref the mss
// branding registry cannot serve. A branding ref emitted WITHOUT this
// flag fails closed.
//
// `publish-candidate` is the P5 operator-approval entrypoint: it builds
// + validates a candidate bundle from approved content and writes a
// candidate pointer ONLY — it never swaps the live current.json. The
// legacy cross-repo commit producer is disabled unless
// `--enable-crossrepo-producer` is passed.
//
// `promote-candidate` / `rollback` are the P6 canary primitives that
// DO flip the live pointer. They only run against the prod artifact root
// under operator authorization (canon §1: changing live ad traffic).
//
// Signing keys are passed by the operator (file paths); the CLI never
// reads keys from the artifact root.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { compileBundle, CompileError, type CompileInput } from './compile.js'
import type { BrandingOpaqueRegistry } from './registryCheck.js'
import { loadBrandingOpaqueRegistry } from '../branding/publish.js'
import { generateEd25519Pem, publicKeyPemFromPrivate } from './signing.js'
import { publishBundle, type LpEnvironment } from './publish.js'
import { publishApprovedContentCandidate } from './publishCandidate.js'
import { promoteCandidate, rollbackToBundle } from './promoteCandidate.js'
import { validateBundle } from './validate.js'

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
  if (v === undefined) {
    throw new Error(`missing required --${name}`)
  }
  return v
}

/**
 * Load the branding-opaque parity registry when `--branding-pubkey` is given
 * (the ed25519 public key the branding manifest is signed with — typically the
 * same key as the LP bundle). The registry is read fail-closed from
 * `<root>/branding-opaque/<env>/current.json` (override with `--branding-env`
 * or `--branding-pointer`); a load failure THROWS so a bundle that needs the
 * parity check never publishes against a missing/corrupt registry.
 *
 * When the flag is absent the registry is `undefined`; that is fine for bundles
 * with no `branding` refs, and the parity check itself fails closed if a
 * branding ref IS emitted without a registry (see `checkBrandingRefParity`).
 */
function maybeLoadBrandingRegistry(
  args: Args,
  root: string,
  environment: string | undefined,
): BrandingOpaqueRegistry | undefined {
  const pubkeyPath = args.flags['branding-pubkey']
  if (pubkeyPath === undefined) return undefined
  const publicKeyPem = readFileSync(pubkeyPath, 'utf8')
  const loaded = loadBrandingOpaqueRegistry({
    artifactRoot: root,
    environment: args.flags['branding-env'] ?? environment,
    pointerPath: args.flags['branding-pointer'],
    publicKeyPem,
  })
  if (!loaded.ok || loaded.registry === undefined) {
    throw new Error(
      `failed to load the branding-opaque registry (required for the branding ` +
        `parity check):\n  - ${loaded.errors.join('\n  - ')}`,
    )
  }
  process.stdout.write(
    `  branding registry: ${loaded.manifestId ?? '?'} v${loaded.version ?? 0} ` +
      `(${loaded.entryCount ?? 0} entries)\n`,
  )
  return loaded.registry
}

const ENVIRONMENTS: readonly LpEnvironment[] = ['prod', 'preview', 'staging', 'nonprod']

function asEnvironment(v: string): LpEnvironment {
  if ((ENVIRONMENTS as readonly string[]).includes(v)) return v as LpEnvironment
  throw new Error(`invalid --env '${v}' (expected one of ${ENVIRONMENTS.join(', ')})`)
}

function cmdKeygen(): number {
  const { publicKeyPem, privateKeyPem } = generateEd25519Pem()
  process.stdout.write(`# ed25519 keypair for landing-page bundle signing\n`)
  process.stdout.write(`# Store the PRIVATE key with Helios only (never on /cloud).\n`)
  process.stdout.write(`\n# --- PRIVATE (signing) ---\n${privateKeyPem}`)
  process.stdout.write(`\n# --- PUBLIC (verify; ship to mss) ---\n${publicKeyPem}`)
  return 0
}

function cmdPublish(args: Args): number {
  const root = requireFlag(args, 'root')
  const environment = asEnvironment(requireFlag(args, 'env'))
  const configPath = requireFlag(args, 'config')
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')
  const dryRun = args.bools.has('dry-run')

  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    sites: Record<string, unknown>
    families: Record<string, unknown>
    components: Record<string, unknown>
    variants: unknown[]
    policy: { policy_version_id: string; selection_algorithm_version: string; rules: unknown[] }
    disabledVariants?: unknown[]
    minRendererVersion?: string
    automationGitSha?: string
    generatedFrom?: { cluster_sweep_run_id?: number; asset_approval_snapshot_id?: number; policy_version_id?: string }
    previousBundleId?: string
  }

  const brandingRegistry = maybeLoadBrandingRegistry(args, root, environment)

  const compiled = compileBundle({
    sites: cfg.sites as never,
    families: cfg.families as never,
    components: cfg.components as never,
    variants: cfg.variants as never,
    policy: cfg.policy as never,
    disabledVariants: cfg.disabledVariants as never,
    brandingRegistry,
  })

  const result = publishBundle({
    compiled,
    privateKeyPem,
    artifactRoot: root,
    environment,
    minRendererVersion: args.flags.renderer ?? cfg.minRendererVersion ?? 'mss-lp-runtime>=0.1.0',
    automationGitSha: args.flags['git-sha'] ?? cfg.automationGitSha ?? '0000000',
    generatedFrom: {
      policy_version_id: cfg.policy.policy_version_id,
      ...(cfg.generatedFrom?.cluster_sweep_run_id ? { cluster_sweep_run_id: cfg.generatedFrom.cluster_sweep_run_id } : {}),
      ...(cfg.generatedFrom?.asset_approval_snapshot_id
        ? { asset_approval_snapshot_id: cfg.generatedFrom.asset_approval_snapshot_id }
        : {}),
    },
    previousBundleId: args.flags.prev ?? cfg.previousBundleId,
    disabledVariants: cfg.disabledVariants as never,
    dryRun,
  })

  process.stdout.write(
    `${dryRun ? '[dry-run] ' : ''}published ${result.bundleId} v${result.version}\n` +
      `  bundleDir: ${result.bundleDir}\n` +
      `  pointer:   ${result.pointerPath}\n`,
  )

  // Self-validate what we just wrote (publishes that fail their own
  // validation are a bug; surface it loudly).
  const publicKeyPem = publicKeyPemFromPrivate(privateKeyPem)
  const v = validateBundle({
    artifactRoot: root,
    pointerPath: result.pointerPath,
    publicKeyPem,
    runningRendererVersion: args.flags['verify-renderer'] ?? '999.0.0',
    brandingRegistry,
  })
  if (!v.ok) {
    process.stderr.write(`SELF-VALIDATION FAILED:\n  - ${v.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(`  self-validation: ok\n`)
  return 0
}

// P5: operator-approval-triggered dual-publish-candidate. Builds +
// validates a candidate bundle from approved content and writes a
// candidate pointer ONLY (never the live current.json). The legacy
// cross-repo commit producer stays disabled unless
// `--enable-crossrepo-producer` is passed (parent EPIC_PLAN §10 P5).
function cmdPublishCandidate(args: Args): number {
  const root = requireFlag(args, 'root')
  const environment = asEnvironment(requireFlag(args, 'env'))
  const configPath = requireFlag(args, 'config')
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')
  // Validate against the mss-trusted public key when given (catches a
  // wrong signing key now instead of a silent mss rejection later);
  // fall back to the derived key for non-prod self-consistency checks.
  const publicKeyPem = args.flags.pubkey
    ? readFileSync(args.flags.pubkey, 'utf8')
    : publicKeyPemFromPrivate(privateKeyPem)
  // The renderer to validate against MUST be the version actually
  // deployed in mss — no permissive sentinel.
  const verifyRendererVersion = requireFlag(args, 'verify-renderer')

  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    sites: Record<string, unknown>
    families: Record<string, unknown>
    components: Record<string, unknown>
    variants: unknown[]
    policy: { policy_version_id: string; selection_algorithm_version: string; rules: unknown[] }
    disabledVariants?: unknown[]
    minRendererVersion?: string
    automationGitSha?: string
    generatedFrom?: { cluster_sweep_run_id?: number; asset_approval_snapshot_id?: number; policy_version_id?: string }
    previousBundleId?: string
  }

  const brandingRegistry = maybeLoadBrandingRegistry(args, root, environment)

  const approvedContent: CompileInput = {
    sites: cfg.sites as never,
    families: cfg.families as never,
    components: cfg.components as never,
    variants: cfg.variants as never,
    policy: cfg.policy as never,
    disabledVariants: cfg.disabledVariants as never,
    brandingRegistry,
  }

  const result = publishApprovedContentCandidate({
    approvedContent,
    privateKeyPem,
    publicKeyPem,
    artifactRoot: root,
    environment,
    minRendererVersion: args.flags.renderer ?? cfg.minRendererVersion ?? 'mss-lp-runtime>=0.1.0',
    automationGitSha: args.flags['git-sha'] ?? cfg.automationGitSha ?? '0000000',
    generatedFrom: {
      policy_version_id: cfg.policy.policy_version_id,
      ...(cfg.generatedFrom?.cluster_sweep_run_id ? { cluster_sweep_run_id: cfg.generatedFrom.cluster_sweep_run_id } : {}),
      ...(cfg.generatedFrom?.asset_approval_snapshot_id
        ? { asset_approval_snapshot_id: cfg.generatedFrom.asset_approval_snapshot_id }
        : {}),
    },
    previousBundleId: args.flags.prev ?? cfg.previousBundleId,
    disabledVariants: cfg.disabledVariants as never,
    verifyRendererVersion,
    crossRepoCommitProducerEnabled: args.bools.has('enable-crossrepo-producer'),
  })

  const producerLine = result.crossRepoCommitProducerEnabled
    ? 'requested ENABLED (policy marker only; Helios has no legacy producer to run — see runbook)'
    : 'disabled (default)'
  process.stdout.write(
    `candidate ${result.bundleId} v${result.version}\n` +
      `  candidatePointer: ${result.candidatePointerPath}\n` +
      `  bundleDir:        ${result.bundleDir}\n` +
      `  crossRepoCommitProducer: ${producerLine}\n`,
  )
  if (!result.ok) {
    process.stderr.write(`CANDIDATE INVALID:\n  - ${result.validation.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(`  self-validation: ok\n  next: ${result.promoteHint}\n`)
  return 0
}

// P6: promote a validated candidate to the live current.json. THIS FLIPS
// LIVE TRAFFIC — only an operator runs it against prod /cloud (canon §1).
function cmdPromoteCandidate(args: Args): number {
  const root = requireFlag(args, 'root')
  const environment = asEnvironment(requireFlag(args, 'env'))
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')
  const publicKeyPem = readFileSync(requireFlag(args, 'pubkey'), 'utf8')
  const runningRendererVersion = requireFlag(args, 'renderer')

  const result = promoteCandidate({
    artifactRoot: root,
    environment,
    privateKeyPem,
    publicKeyPem,
    runningRendererVersion,
    allowVersionRebase: args.bools.has('allow-version-rebase'),
    brandingRegistry: maybeLoadBrandingRegistry(args, root, environment),
  })

  if (!result.ok) {
    process.stderr.write(`PROMOTE FAILED:\n  - ${result.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(
    `promoted ${result.bundleId} → live v${result.toVersion} (from v${result.fromVersion})\n` +
      `  livePointer: ${result.livePointerPath}\n` +
      `  ${result.rollbackHint ?? ''}\n`,
  )
  return 0
}

// P6 rollback: publish a NEW higher-versioned live pointer at a previous
// good bundle. Operator-only against prod /cloud (canon §1).
function cmdRollback(args: Args): number {
  const root = requireFlag(args, 'root')
  const environment = asEnvironment(requireFlag(args, 'env'))
  const privateKeyPem = readFileSync(requireFlag(args, 'privkey'), 'utf8')
  const publicKeyPem = readFileSync(requireFlag(args, 'pubkey'), 'utf8')
  const runningRendererVersion = requireFlag(args, 'renderer')
  const toBundleId = requireFlag(args, 'to-bundle')

  const result = rollbackToBundle({
    artifactRoot: root,
    environment,
    toBundleId,
    privateKeyPem,
    publicKeyPem,
    runningRendererVersion,
    brandingRegistry: maybeLoadBrandingRegistry(args, root, environment),
  })

  if (!result.ok) {
    process.stderr.write(`ROLLBACK FAILED:\n  - ${result.errors.join('\n  - ')}\n`)
    return 1
  }
  process.stdout.write(
    `rolled back to ${result.bundleId} → live v${result.toVersion} (from v${result.fromVersion})\n` +
      `  livePointer: ${result.livePointerPath}\n`,
  )
  return 0
}

function cmdValidate(args: Args): number {
  const root = requireFlag(args, 'root')
  const publicKeyPem = readFileSync(requireFlag(args, 'pubkey'), 'utf8')
  const result = validateBundle({
    artifactRoot: root,
    environment: args.flags.env,
    pointerPath: args.flags.pointer,
    publicKeyPem,
    runningRendererVersion: args.flags.renderer ?? '0.0.0',
    activeVersion: args.flags.active ? Number.parseInt(args.flags.active, 10) : undefined,
    brandingRegistry: maybeLoadBrandingRegistry(args, root, args.flags.env),
  })
  if (result.ok) {
    process.stdout.write(`VALID ${result.bundleId} v${result.version}\n`)
    return 0
  }
  process.stderr.write(`INVALID${result.bundleId ? ` ${result.bundleId}` : ''}:\n  - ${result.errors.join('\n  - ')}\n`)
  return 1
}

export function main(argv: string[]): number {
  const args = parseArgs(argv)
  const command = args._[0]
  try {
    switch (command) {
      case 'keygen':
        return cmdKeygen()
      case 'publish':
        return cmdPublish(args)
      case 'publish-candidate':
        return cmdPublishCandidate(args)
      case 'promote-candidate':
        return cmdPromoteCandidate(args)
      case 'rollback':
        return cmdRollback(args)
      case 'validate':
        return cmdValidate(args)
      default:
        process.stderr.write(
          'usage: lp-bundle <keygen|publish|publish-candidate|promote-candidate|rollback|validate> [options]\n',
        )
        return 2
    }
  } catch (e) {
    if (e instanceof CompileError) {
      process.stderr.write(`${e.message}\n`)
      return 1
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

/* istanbul ignore next — entrypoint guard */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
