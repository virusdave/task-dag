// `helios lp-bundle` CLI — keygen / compile+publish (incl. --dry-run) /
// validate. The Helios-side P1 deliverable (parent EPIC_PLAN §10 P1 +
// the automation#42 "Validation CLI" item).
//
// Run with tsx:
//   tsx src/server/lp/cli.ts keygen
//   tsx src/server/lp/cli.ts publish --root /cloud/lp --env prod \
//       --config ./bundle-input.json --privkey ./signing.pem [--dry-run]
//   tsx src/server/lp/cli.ts validate --root /cloud/lp --env prod \
//       --pubkey ./signing.pub.pem --renderer 0.4.0 [--active 4411]
//
// Signing keys are passed by the operator (file paths); the CLI never
// reads keys from the artifact root.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { compileBundle, CompileError } from './compile.js'
import { generateEd25519Pem, publicKeyPemFromPrivate } from './signing.js'
import { publishBundle, type LpEnvironment } from './publish.js'
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

  const compiled = compileBundle({
    sites: cfg.sites as never,
    families: cfg.families as never,
    components: cfg.components as never,
    variants: cfg.variants as never,
    policy: cfg.policy as never,
    disabledVariants: cfg.disabledVariants as never,
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
  const result = validateBundle({
    artifactRoot: root,
    environment: args.flags.env,
    pointerPath: args.flags.pointer,
    publicKeyPem,
    runningRendererVersion: args.flags.renderer ?? '0.0.0',
    activeVersion: args.flags.active ? Number.parseInt(args.flags.active, 10) : undefined,
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
      case 'validate':
        return cmdValidate(args)
      default:
        process.stderr.write('usage: lp-bundle <keygen|publish|validate> [options]\n')
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
