/**
 * Optional worker supervisor.
 *
 * Spawns one tsx child per execution pool so Sweed-touching jobs run in a
 * dedicated singleton process while ads / scheduling / system jobs run in
 * their own isolated processes. Each child sees `WORKER_POOL=<pool>` in env
 * and `src/worker/main.ts` reads that selector via `getWorkerEnv()`.
 *
 * The default `npm run dev:worker` script keeps spawning a single all-pools
 * worker so the operator-facing dev loop and the live `helios-dev` tmux
 * session are unchanged. This script is opt-in; run it directly with
 *
 *     tsx scripts/runWorkerSupervisor.ts
 *
 * Pools can be limited via the `WORKER_SUPERVISOR_POOLS` env var (comma
 * separated, e.g. `sweed,system`). Defaults to all four pools.
 *
 * Forwards stdout/stderr from each child with a `[<pool>]` prefix and
 * propagates SIGTERM/SIGINT so a single Ctrl-C tears down the whole tree.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { JOB_EXECUTION_POOLS, type JobExecutionPool } from '../src/worker/runtime/jobPools.js'

interface SupervisedChild {
  child: ChildProcess
  pool: JobExecutionPool
}

function parsePoolsFromEnv(): JobExecutionPool[] {
  const raw = process.env.WORKER_SUPERVISOR_POOLS?.trim()
  if (!raw) {
    return [...JOB_EXECUTION_POOLS]
  }
  const requested = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  const valid: JobExecutionPool[] = []
  for (const candidate of requested) {
    if ((JOB_EXECUTION_POOLS as readonly string[]).includes(candidate)) {
      valid.push(candidate as JobExecutionPool)
    } else {
      throw new Error(
        `WORKER_SUPERVISOR_POOLS contains unknown pool '${candidate}'; expected one of ${JOB_EXECUTION_POOLS.join(', ')}.`,
      )
    }
  }
  if (valid.length === 0) {
    throw new Error('WORKER_SUPERVISOR_POOLS resolved to an empty pool list.')
  }
  return valid
}

function spawnChild(pool: JobExecutionPool, workerEntry: string): SupervisedChild {
  const child = spawn('tsx', ['watch', workerEntry], {
    env: {
      ...process.env,
      WORKER_POOL: pool,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(prefixLines(`[${pool}]`, chunk.toString('utf8')))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(prefixLines(`[${pool}!]`, chunk.toString('utf8')))
  })

  child.on('exit', (code, signal) => {
    process.stderr.write(
      `[supervisor] worker pool='${pool}' exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
    )
    if (code !== 0 && signal === null) {
      // Propagate non-zero pool failure to the supervisor's exit so it does
      // not silently keep running while one pool is dead.
      process.exitCode = code ?? 1
    }
  })

  return { child, pool }
}

function prefixLines(prefix: string, text: string): string {
  if (!text.endsWith('\n')) {
    text = `${text}\n`
  }
  return text
    .split('\n')
    .map((line, index, arr) => (index === arr.length - 1 ? line : `${prefix} ${line}\n`))
    .join('')
}

function forwardSignal(children: SupervisedChild[], signal: NodeJS.Signals): void {
  for (const supervised of children) {
    if (!supervised.child.killed) {
      try {
        supervised.child.kill(signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown signal forwarding error.'
        process.stderr.write(`[supervisor] failed to forward ${signal} to '${supervised.pool}': ${message}\n`)
      }
    }
  }
}

function main(): void {
  const pools = parsePoolsFromEnv()
  const here = dirname(fileURLToPath(import.meta.url))
  const workerEntry = resolve(here, '..', 'src', 'worker', 'main.ts')

  process.stdout.write(`[supervisor] starting pools: ${pools.join(', ')}\n`)
  const children = pools.map((pool) => spawnChild(pool, workerEntry))

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      process.stderr.write(`[supervisor] received ${signal}, forwarding to pool workers\n`)
      forwardSignal(children, signal)
    })
  }
}

main()
