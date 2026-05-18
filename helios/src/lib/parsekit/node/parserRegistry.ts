/**
 * parsekit ParserRegistry — process-wide holder of the current
 * `CompiledRelease`.
 *
 * Lifecycle:
 *   - `initParserRegistry({...})` is called once at server / worker
 *     startup. It (optionally) clones the helios-parser-configs repo,
 *     loads + validates the snapshot, and arms a periodic refresh.
 *   - `getParserRegistry()` returns the singleton; callers (e.g. the
 *     reverse-shadow harness in `pendingPurchases/`) read
 *     `registry.current()` to get the latest compiled release.
 *   - The registry is **non-blocking**: if initial load fails the
 *     registry reports `null` and logs; the server still boots and
 *     legacy code paths keep working.
 *
 * The "from local directory" mode (no git, just point at a checkout)
 * is the primary one for local dev and tests; production wraps it
 * with the git mirror.
 */

import { syncMirror, defaultMirrorPath, type MirrorLogger } from './gitMirror.js'
import { loadParserConfigsFromDir, type LoaderRegistries, type LoadError } from './configLoader.js'
import type { CompiledRelease } from '../types.js'

export interface RegistryLogger extends MirrorLogger {}

export interface RegistryStatus {
  initialized: boolean
  /** Current compiled release sha, or null if no successful load yet. */
  sha: string | null
  /** When the current release was loaded (epoch ms). */
  loadedAtMs: number | null
  /** Errors from the most recent load attempt. Empty on full success. */
  lastErrors: LoadError[]
  /** Wall-clock time of last refresh attempt (success or failure). */
  lastAttemptAtMs: number | null
  /** Number of successful loads since init. */
  successfulLoads: number
  /** Number of failed loads since init. */
  failedLoads: number
}

export interface InitOptions {
  registries: LoaderRegistries
  /** Where the on-disk checkout lives. If `repoUrl` is set and this is
   *  empty, a default under `~/.cache/helios/parser-configs/<repo>` is
   *  used. */
  localDir?: string
  /** Remote URL. When null, the loader runs in **local-only** mode
   *  (no clone, no fetch) — it just reads `localDir`. */
  repoUrl?: string | null
  /** Branch on origin to track. Default: "master". */
  branch?: string
  /** How often to re-fetch + reload. `0` disables auto-refresh. */
  refreshIntervalMs?: number
  /** Logger; defaults to a console-backed logger. */
  log?: RegistryLogger
  /** Root dir for default `localDir` resolution. Default: $XDG_CACHE_HOME
   *  or `~/.cache`. */
  cacheRoot?: string
}

export type ReleaseSubscriber = (release: CompiledRelease) => void

export class ParserRegistry {
  private release: CompiledRelease | null = null
  private status: RegistryStatus = {
    initialized: false,
    sha: null,
    loadedAtMs: null,
    lastErrors: [],
    lastAttemptAtMs: null,
    successfulLoads: 0,
    failedLoads: 0,
  }
  private subscribers = new Set<ReleaseSubscriber>()
  private timer: NodeJS.Timeout | null = null
  private opts: ResolvedOptions | null = null
  private refreshInFlight = false

  current(): CompiledRelease | null {
    return this.release
  }

  getStatus(): RegistryStatus {
    return { ...this.status, lastErrors: [...this.status.lastErrors] }
  }

  subscribe(cb: ReleaseSubscriber): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  async init(opts: InitOptions): Promise<RegistryStatus> {
    if (this.opts) {
      throw new Error('ParserRegistry: already initialized')
    }
    this.opts = resolveOptions(opts)
    this.status.initialized = true

    await this.refreshOnce(/*forceLog*/ true)

    if (this.opts.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.refreshOnce(false).catch((err) => {
          this.opts!.log.error('parser-configs: refresh threw', { err: errMessage(err) })
        })
      }, this.opts.refreshIntervalMs)
      // Don't keep the event loop alive just for this.
      this.timer.unref?.()
    }

    return this.getStatus()
  }

  /** Trigger a one-shot fetch+reload. Safe to call concurrently
   *  (additional invocations short-circuit until the in-flight one
   *  completes). */
  async refresh(): Promise<RegistryStatus> {
    if (!this.opts) {
      throw new Error('ParserRegistry: refresh before init')
    }
    await this.refreshOnce(false)
    return this.getStatus()
  }

  /** Halt the periodic refresh timer. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async refreshOnce(forceLog: boolean): Promise<void> {
    if (!this.opts) return
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    this.status.lastAttemptAtMs = Date.now()
    try {
      const sha = await this.ensureLatestCheckout(forceLog)
      const { release, errors } = loadParserConfigsFromDir({
        dir: this.opts.localDir,
        sha,
        registries: this.opts.registries,
      })
      if (release) {
        const previousSha = this.status.sha
        this.release = release
        this.status.sha = release.sha
        this.status.loadedAtMs = Date.now()
        this.status.lastErrors = []
        this.status.successfulLoads += 1
        if (previousSha !== release.sha || forceLog) {
          this.opts.log.info('parser-configs: snapshot loaded', {
            sha: release.sha,
            parsers: release.parsers.size,
          })
        }
        for (const cb of this.subscribers) {
          try {
            cb(release)
          } catch (err) {
            this.opts.log.warn('parser-configs: subscriber threw', { err: errMessage(err) })
          }
        }
      } else {
        this.status.lastErrors = errors
        this.status.failedLoads += 1
        this.opts.log.error('parser-configs: snapshot rejected', {
          sha,
          errorCount: errors.length,
          firstError: errors[0],
        })
      }
    } catch (err) {
      this.status.failedLoads += 1
      this.opts!.log.error('parser-configs: refresh failed', { err: errMessage(err) })
    } finally {
      this.refreshInFlight = false
    }
  }

  private async ensureLatestCheckout(forceLog: boolean): Promise<string> {
    if (!this.opts) throw new Error('not initialized')
    if (this.opts.repoUrl === null) {
      // Local-only mode: the caller manages the working tree.
      return 'local:' + this.opts.localDir
    }
    const result = await syncMirror({
      url: this.opts.repoUrl,
      localDir: this.opts.localDir,
      defaultBranch: this.opts.branch,
      log: this.opts.log,
    })
    if (result.changed && !forceLog) {
      this.opts.log.info('parser-configs: new snapshot available', {
        previousSha: result.previousSha,
        sha: result.sha,
      })
    }
    return result.sha
  }
}

interface ResolvedOptions {
  registries: LoaderRegistries
  localDir: string
  repoUrl: string | null
  branch: string
  refreshIntervalMs: number
  log: RegistryLogger
}

function resolveOptions(opts: InitOptions): ResolvedOptions {
  const log = opts.log ?? CONSOLE_LOGGER
  const branch = opts.branch ?? 'master'
  const refreshIntervalMs = opts.refreshIntervalMs ?? 60_000

  let localDir = opts.localDir ?? ''
  if (!localDir) {
    if (!opts.repoUrl) {
      throw new Error('ParserRegistry.init: localDir is required when repoUrl is null')
    }
    const cacheRoot =
      opts.cacheRoot ?? process.env.XDG_CACHE_HOME ?? `${process.env.HOME ?? '/tmp'}/.cache`
    localDir = defaultMirrorPath(`${cacheRoot}/helios/parser-configs`, opts.repoUrl)
  }

  return {
    registries: opts.registries,
    localDir,
    repoUrl: opts.repoUrl ?? null,
    branch,
    refreshIntervalMs,
    log,
  }
}

const CONSOLE_LOGGER: RegistryLogger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta })),
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------
// process-wide singleton
// ---------------------------------------------------------------------

let singleton: ParserRegistry | null = null

export function getParserRegistry(): ParserRegistry {
  if (!singleton) {
    singleton = new ParserRegistry()
  }
  return singleton
}

/** Test-only: reset the singleton. */
export function __resetParserRegistry(): void {
  if (singleton) {
    singleton.stop()
  }
  singleton = null
}
