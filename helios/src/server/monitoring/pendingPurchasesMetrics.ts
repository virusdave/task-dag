/**
 * Pending Purchases Monitoring and Metrics
 * Tracks job execution, errors, and operational metrics
 */

export interface JobMetrics {
  jobType: string
  startTime: Date
  endTime?: Date
  durationMs?: number
  status: 'running' | 'succeeded' | 'failed'
  rowsProcessed?: number
  errorCount?: number
  errorDetails?: string[]
}

export interface SystemMetrics {
  apiCalls: {
    sweed: number
    litAlerts: number
    mantle: number
  }
  llmCost: number
  packetStats: {
    generated: number
    imported: number
    applied: number
  }
}

const jobMetrics: JobMetrics[] = []
const systemMetrics: SystemMetrics = {
  apiCalls: { sweed: 0, litAlerts: 0, mantle: 0 },
  llmCost: 0,
  packetStats: { generated: 0, imported: 0, applied: 0 },
}

/**
 * Start tracking a job
 */
export function startJobMetrics(jobType: string): string {
  const jobId = `${jobType}-${Date.now()}`
  jobMetrics.push({
    jobType,
    startTime: new Date(),
    status: 'running',
  })
  return jobId
}

/**
 * Complete job metrics
 */
export function completeJobMetrics(
  jobId: string,
  success: boolean,
  details?: { rowsProcessed?: number; errorCount?: number; errorDetails?: string[] }
): void {
  const metric = jobMetrics.find((m) => m.jobType === jobId.split('-')[0] && m.status === 'running')
  if (metric) {
    metric.endTime = new Date()
    metric.durationMs = metric.endTime.getTime() - metric.startTime.getTime()
    metric.status = success ? 'succeeded' : 'failed'
    if (details) {
      metric.rowsProcessed = details.rowsProcessed
      metric.errorCount = details.errorCount
      metric.errorDetails = details.errorDetails
    }
    
    // Check thresholds and alert if needed
    checkThresholds(metric)
  }
}

/**
 * Record API call
 */
export function recordAPICall(service: 'sweed' | 'litAlerts' | 'mantle'): void {
  systemMetrics.apiCalls[service]++
}

/**
 * Record LLM cost
 */
export function recordLLMCost(cost: number): void {
  systemMetrics.llmCost += cost
}

/**
 * Get current metrics
 */
export function getMetrics(): { jobs: JobMetrics[]; system: SystemMetrics } {
  return {
    jobs: jobMetrics.slice(-100), // Last 100 jobs
    system: systemMetrics,
  }
}

/**
 * Check thresholds and alert
 */
function checkThresholds(metric: JobMetrics): void {
  // Check duration
  if (metric.jobType === 'generatePendingPurchasePacket' && metric.durationMs! > 600000) {
    console.warn(`Generate job took ${metric.durationMs}ms (threshold: 600000ms)`)
    // TODO: page-dave
  }
  
  // Check failure rate for apply jobs
  if (metric.jobType === 'applyPendingPurchaseRequest' && metric.errorCount && metric.rowsProcessed) {
    const failureRate = metric.errorCount / metric.rowsProcessed
    if (failureRate > 0.2) {
      console.error(`Apply job failure rate: ${(failureRate * 100).toFixed(1)}% (threshold: 20%)`)
      // TODO: page-dave
    }
  }
}
