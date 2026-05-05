import { JobStatusResponseSchema, type JobStatusResponse } from '../../shared/contracts/index.js'
import { loadJson } from './fetchJson.js'

export async function loadJobStatus(jobId: number): Promise<JobStatusResponse> {
  return loadJson(`/api/jobs/${jobId}`, JobStatusResponseSchema)
}

export function isJobTerminal(status: JobStatusResponse['job']['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'dead_letter'
}

export async function waitForJob(jobId: number): Promise<JobStatusResponse> {
  for (;;) {
    const response = await loadJobStatus(jobId)
    if (isJobTerminal(response.job.status)) {
      return response
    }
    await delay(1000)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
