import { spawn } from 'node:child_process'

const PAGE_DAVE_COMMAND_CANDIDATES = [
  '/run/current-system/sw/bin/page-dave',
  'page-dave',
] as const

export type PageDavePriority = 1 | 2 | 3 | 4 | 5

export interface PageDaveOptions {
  /** ntfy priority 1..5 (default: 4 / 'high'). */
  priority?: PageDavePriority
  /** Short notification headline. */
  title?: string
}

/**
 * Send a notification to Dave via the `page-dave` CLI. Supports the
 * full `-p <priority>` + `-t "<title>"` shape documented in
 * AGENTS.md. The first positional arg is the message body.
 *
 * Backwards compatible: `pageDave('hello')` still works — priority
 * and title default to the CLI's defaults.
 */
export async function pageDave(message: string, options: PageDaveOptions = {}): Promise<void> {
  const args = buildPageDaveArgs(message, options)
  let commandNotFoundError: Error | null = null

  for (const command of PAGE_DAVE_COMMAND_CANDIDATES) {
    try {
      await runPageDaveCommand(command, args)
      return
    } catch (error) {
      if (isCommandNotFoundError(error)) {
        commandNotFoundError = error
        continue
      }
      throw error
    }
  }

  throw commandNotFoundError ?? new Error('page-dave command is not available in this environment.')
}

function buildPageDaveArgs(message: string, options: PageDaveOptions): string[] {
  const args: string[] = []
  if (options.priority !== undefined) {
    args.push('-p', String(options.priority))
  }
  if (options.title !== undefined && options.title.length > 0) {
    args.push('-t', options.title)
  }
  args.push(message)
  return args
}

async function runPageDaveCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`page-dave exited unsuccessfully (${code ?? signal ?? 'unknown'}).`))
    })
  })
}

function isCommandNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
