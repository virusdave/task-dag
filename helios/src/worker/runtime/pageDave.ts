import { spawn } from 'node:child_process'

const PAGE_DAVE_COMMAND_CANDIDATES = [
  '/run/current-system/sw/bin/page-dave',
  'page-dave',
] as const

export async function pageDave(message: string): Promise<void> {
  let commandNotFoundError: Error | null = null

  for (const command of PAGE_DAVE_COMMAND_CANDIDATES) {
    try {
      await runPageDaveCommand(command, message)
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

async function runPageDaveCommand(command: string, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [message], {
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
