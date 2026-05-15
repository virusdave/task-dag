/**
 * Error Handler for Pending Purchases
 * Implements retry logic, circuit breaker, and page-dave integration
 */

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retriesLeft: number = 3,
    public readonly backoffMs: number = 1000
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly shouldPageDave: boolean = true
  ) {
    super(message)
    this.name = 'PermanentError'
  }
}

export interface RetryConfig {
  maxAttempts: number
  backoffMs: number[]
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  backoffMs: [1000, 5000, 15000], // 1s, 5s, 15s
}

/**
 * Execute function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = 'operation'
): Promise<T> {
  let lastError: Error | undefined
  
  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      
      // Check if error is retryable
      if (error instanceof PermanentError) {
        if (error.shouldPageDave) {
          await pageDave(`Permanent error in ${context}: ${error.message}`, 5)
        }
        throw error
      }
      
      // Check if we have retries left
      if (attempt < config.maxAttempts - 1) {
        const backoffMs = config.backoffMs[attempt] || config.backoffMs[config.backoffMs.length - 1]
        console.warn(`${context} failed (attempt ${attempt + 1}/${config.maxAttempts}), retrying in ${backoffMs}ms:`, error)
        await sleep(backoffMs)
      }
    }
  }
  
  // All retries exhausted
  await pageDave(`All retries exhausted for ${context}: ${lastError?.message}`, 5)
  throw lastError
}

/**
 * Circuit breaker state
 */
export class CircuitBreaker {
  private failures = 0
  private lastFailureTime?: number
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  
  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60000 // 1 minute
  ) {}
  
  async execute<T>(fn: () => Promise<T>, context: string): Promise<T> {
    if (this.state === 'open') {
      // Check if we should try half-open
      if (this.lastFailureTime && Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'half-open'
      } else {
        throw new PermanentError(`Circuit breaker open for ${context}`, false)
      }
    }
    
    try {
      const result = await fn()
      
      // Success - reset circuit breaker
      if (this.state === 'half-open') {
        this.state = 'closed'
        this.failures = 0
      }
      
      return result
    } catch (error) {
      this.failures++
      this.lastFailureTime = Date.now()
      
      if (this.failures >= this.failureThreshold) {
        this.state = 'open'
        await pageDave(`Circuit breaker opened for ${context} after ${this.failures} failures`, 5)
      }
      
      throw error
    }
  }
}

/**
 * Page Dave with error
 */
async function pageDave(message: string, priority: number = 4): Promise<void> {
  try {
    // TODO: Implement actual page-dave call
    // For now, log to console
    console.error(`[PAGE-DAVE P${priority}] ${message}`)
  } catch (error) {
    console.error('Failed to page Dave:', error)
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Classify error type
 */
export function classifyError(error: unknown, context: string): Error {
  const err = error as any
  
  // Network errors - retryable
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
    return new RetryableError(`Network error in ${context}: ${err.message}`)
  }
  
  // Rate limit - retryable with longer backoff
  if (err.statusCode === 429 || err.code === 'RATE_LIMITED') {
    return new RetryableError(`Rate limited in ${context}`, 3, 30000)
  }
  
  // Auth errors - permanent
  if (err.statusCode === 401 || err.statusCode === 403) {
    return new PermanentError(`Authentication failed in ${context}: ${err.message}`)
  }
  
  // Validation errors - permanent
  if (err.statusCode === 400 || err.name === 'ValidationError') {
    return new PermanentError(`Validation error in ${context}: ${err.message}`, false)
  }
  
  // Unknown - retryable once
  return new RetryableError(`Unknown error in ${context}: ${err.message}`, 1)
}
