import { JobStatusResponseSchema, type JobStatusResponse } from '../../shared/contracts/index.js'
import { loadJson } from './fetchJson.js'

export async function loadJobStatus(jobId: number): Promise<JobStatusResponse> {
  return loadJson(`/api/jobs/${jobId}`, JobStatusResponseSchema)
}

export function isJobTerminal(status: JobStatusResponse['job']['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'dead_letter'
}

export interface WaitForJobOptions {
  /**
   * Max time to poll before giving up, in ms. When omitted, polls
   * indefinitely (the historical behaviour). Callers that block UI on
   * the result should ALWAYS pass a bound so a stuck/slow background job
   * can't freeze the surface forever.
   */
  timeoutMs?: number
  /** Poll interval in ms (default 1000). */
  pollMs?: number
}

/** Thrown by `waitForJob` when `timeoutMs` elapses before the job is terminal. */
export class JobWaitTimeoutError extends Error {
  constructor(
    public readonly jobId: number,
    public readonly lastStatus: JobStatusResponse['job']['status'],
  ) {
    super(`Job #${jobId} is still ${lastStatus} after the wait timeout; check the Jobs page.`)
    this.name = 'JobWaitTimeoutError'
  }
}

export async function waitForJob(
  jobId: number,
  options: WaitForJobOptions = {},
): Promise<JobStatusResponse> {
  const pollMs = options.pollMs ?? 1000
  const startedAt = Date.now()
  for (;;) {
    const response = await loadJobStatus(jobId)
    if (isJobTerminal(response.job.status)) {
      return response
    }
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      throw new JobWaitTimeoutError(jobId, response.job.status)
    }
    await delay(pollMs)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
