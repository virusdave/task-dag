/**
 * bootstrapParserRegistry — convenience entrypoint called from the
 * server and worker `main.ts` files.
 *
 * Reads `HELIOS_PARSER_CONFIGS_*` env vars, registers the in-repo
 * dialects + use-case contracts, and arms the registry's periodic
 * refresh.
 *
 * Loud-but-non-fatal: if initial load fails (e.g. the
 * helios-parser-configs repo isn't reachable, or a config rejects
 * validation), the registry stays at `current() === null` and the
 * caller keeps the legacy code path. The error is logged via the
 * provided logger.
 */

import { metrcV1Dialect } from '../dialects/metrc-v1.js'
import { litalertsV1Dialect } from '../dialects/litalerts-v1.js'
import { pendingPurchasesContract } from '../contracts/pendingPurchases.js'
import { litalertsContract } from '../contracts/litalerts.js'
import type { DialectPack, UseCaseContract } from '../types.js'
import {
  getParserRegistry,
  type InitOptions,
  type RegistryLogger,
  type RegistryStatus,
} from './parserRegistry.js'

/**
 * Default clone URL. The "natural" SSH URL works two ways:
 *   - For the `amp-local` user, the system-wide SSH alias
 *     `github-helios-parser-configs` (and a per-user gitconfig
 *     `url … insteadOf …` rewrite) routes the natural URL through
 *     the dedicated deploy key (`~amp-local/.ssh/id_ed25519_github_helios_parser_configs`).
 *   - For the `helios` service user, the systemd unit sets
 *     `GIT_SSH_COMMAND` to `ssh -i <helios-readable copy of the key>`,
 *     so the natural URL resolves against the same deploy key.
 * Either way, callers can override via `HELIOS_PARSER_CONFIGS_REPO_URL`.
 */
const DEFAULT_REPO_URL =
  'git@github.com:FreshlyBakedNYC/helios-parser-configs.git'
const DEFAULT_REFRESH_INTERVAL_SECONDS = 60

export interface BootstrapOptions {
  /** Logger; defaults to console JSON lines. */
  log?: RegistryLogger
}

export async function bootstrapParserRegistry(
  opts: BootstrapOptions = {},
): Promise<RegistryStatus | null> {
  const disable = booleanEnv('HELIOS_PARSER_CONFIGS_DISABLE', false)
  if (disable) {
    return null
  }

  const repoUrl = (process.env.HELIOS_PARSER_CONFIGS_REPO_URL ?? DEFAULT_REPO_URL).trim() || null
  const localDir = (process.env.HELIOS_PARSER_CONFIGS_LOCAL_DIR ?? '').trim() || undefined
  const refreshIntervalMs =
    intEnv(
      'HELIOS_PARSER_CONFIGS_REFRESH_SECONDS',
      DEFAULT_REFRESH_INTERVAL_SECONDS,
    ) * 1_000

  const init: InitOptions = {
    registries: buildRegistries(),
    repoUrl,
    localDir,
    refreshIntervalMs,
    log: opts.log,
  }

  try {
    const status = await getParserRegistry().init(init)
    return status
  } catch (err) {
    const log = opts.log
    if (log) {
      log.error('parser-configs: bootstrap threw', { err: errMessage(err) })
    } else {
      console.error(
        JSON.stringify({ level: 'error', msg: 'parser-configs: bootstrap threw', err: errMessage(err) }),
      )
    }
    return {
      initialized: false,
      sha: null,
      loadedAtMs: null,
      lastErrors: [],
      lastAttemptAtMs: Date.now(),
      successfulLoads: 0,
      failedLoads: 1,
    }
  }
}

export function buildRegistries(): InitOptions['registries'] {
  return {
    dialects: new Map<string, DialectPack<unknown>>([
      ['metrc-v1', metrcV1Dialect as unknown as DialectPack<unknown>],
      ['litalerts-v1', litalertsV1Dialect as unknown as DialectPack<unknown>],
    ]),
    contracts: new Map<string, UseCaseContract<unknown>>([
      [
        pendingPurchasesContract.useCase,
        pendingPurchasesContract as unknown as UseCaseContract<unknown>,
      ],
      [
        litalertsContract.useCase,
        litalertsContract as unknown as UseCaseContract<unknown>,
      ],
    ]),
  }
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  if (v === '') return fallback
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function intEnv(name: string, fallback: number): number {
  const v = (process.env[name] ?? '').trim()
  if (v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
