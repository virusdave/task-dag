import { describe, expect, it } from 'vitest'

import { EXPIRED_LEASE_SWEEP_SQL } from './leaseJobs.js'

describe('expired lease sweep SQL', () => {
  it('terminalizes zero-trade-samples while preserving retries for other job types', () => {
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain("job_type in ('catalog.inventory.stage_trade_samples','catalog.inventory.zero_trade_samples') then 'failed' else 'queued'")
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain('then coalesce(finished_at, now()) else null')
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain('will not retry automatically')
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain('Worker lease expired before job completion; retrying.')
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain("select pg_notify('helios_job_queue', '')")
    expect(EXPIRED_LEASE_SWEEP_SQL).toContain('where exists (select 1 from changed)')
    // The subsequent lease query only selects queued rows, so the failed special row cannot become attempt 2.
    expect(EXPIRED_LEASE_SWEEP_SQL).not.toContain("then 'queued' else 'failed'")
  })
})
