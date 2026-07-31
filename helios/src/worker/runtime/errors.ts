export class RetryableWorkerError extends Error {
  readonly delayMs: number | null

  constructor(message: string, options?: { delayMs?: number | null }) {
    super(message)
    this.name = 'RetryableWorkerError'
    this.delayMs = options?.delayMs ?? null
  }
}

export function isRetryableWorkerError(error: unknown): error is RetryableWorkerError {
  return error instanceof RetryableWorkerError
}

export class DependencyUnavailableWorkerError extends RetryableWorkerError {
  constructor(message: string, options?: { delayMs?: number | null }) {
    super(message, options)
    this.name = 'DependencyUnavailableWorkerError'
  }
}

export function isDependencyUnavailableWorkerError(error: unknown): error is DependencyUnavailableWorkerError {
  return error instanceof DependencyUnavailableWorkerError
}

/** A terminal failure message explicitly constructed for operator display. */
export class SafeTerminalWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SafeTerminalWorkerError'
  }
}

export function isSafeTerminalWorkerError(error: unknown): error is SafeTerminalWorkerError {
  return error instanceof SafeTerminalWorkerError
}
