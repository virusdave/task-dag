/**
 * Pending Purchases Job Scheduling Configuration
 * Defines cron schedules and job parameters
 */

export const PENDING_PURCHASES_JOB_SCHEDULES = {
  /**
   * Daily packet generation at 9 AM ET
   * Catches overnight distributor deliveries
   */
  generateDaily: {
    jobType: 'generatePendingPurchasePacket',
    cronSchedule: '0 9 * * *', // 9 AM daily
    timezone: 'America/New_York',
    enabled: true,
    params: {
      dealerIds: [210705, 210249], // Midtown + Bronx
      includeAllPending: true,
    },
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 300000, 900000], // 1min, 5min, 15min
    },
    timeout: 1800000, // 30 minutes
    concurrency: 1, // One at a time
  },
  
  /**
   * On-demand packet import
   * Triggered via API call
   */
  importPacket: {
    jobType: 'importPendingPurchasePacket',
    enabled: true,
    retry: {
      maxAttempts: 2,
      backoffMs: [30000, 120000], // 30s, 2min
    },
    timeout: 600000, // 10 minutes
    concurrency: 5, // Multiple imports can run
  },
  
  /**
   * Apply approved proposals
   * Triggered after manual approval
   */
  applyRequest: {
    jobType: 'applyPendingPurchaseRequest',
    enabled: true,
    retry: {
      maxAttempts: 1, // No auto-retry for mutations
      backoffMs: [],
    },
    timeout: 3600000, // 60 minutes for large packets
    concurrency: 1, // Sequential to avoid Sweed API conflicts
  },
}

/**
 * Job monitoring thresholds
 */
export const MONITORING_THRESHOLDS = {
  generatePacket: {
    maxDurationMs: 600000, // 10 minutes (warn if exceeded)
    maxRowCount: 200, // Warn if packet has more rows
  },
  applyRequest: {
    maxDurationMs: 1800000, // 30 minutes
    failureRateThreshold: 0.2, // Page Dave if >20% rows fail
  },
}
