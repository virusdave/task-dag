import {
  LlmDebugRerunJobPayloadSchema,
  ProposalGenerateDescriptionBatchJobPayloadSchema,
  ProposalGeneratePricingBatchJobPayloadSchema,
  SchedulingExtractConstraintsJobPayloadSchema,
  type JobType,
} from '../../shared/contracts/domain/jobs.js'
import { getWorkerEnv } from '../config/env.js'
import { verifySweedSession } from '../sweed/client.js'
import { DependencyUnavailableWorkerError } from './errors.js'

const DEPENDENCY_RETRY_DELAY_MS = 60_000
const SWEED_HEALTH_CACHE_TTL_MS = 60_000

interface CachedDependencyHealth {
  checkedAt: number
  errorMessage: string | null
}

let cachedSweedHealth: CachedDependencyHealth | null = null

export async function warmDependencyHealth(): Promise<void> {
  const env = getWorkerEnv()

  if (!env.sweedAuthToken) {
    console.warn('SWEED_AUTH_TOKEN is not configured; Sweed-backed jobs will remain queued until the token is available.')
  } else {
    try {
      await assertSweedReady()
      console.info(`Verified Sweed automation context for state dealer ${env.sweedStateDealerId}.`)
    } catch (error) {
      console.warn(error instanceof Error ? error.message : 'Sweed automation verification failed.')
    }
  }

  if (!env.bedrockMantleBearerToken) {
    console.warn('BEDROCK_MANTLE_BEARER_TOKEN is not configured; description generation and pricing-market adaptation jobs will remain queued.')
  }

  if (!env.litAlertsBearerToken) {
    console.info('LITALERTS_BEARER_TOKEN is not configured; pricing generation will remain queued until market research is available.')
  }
}

export async function ensureDependenciesReadyForJob(jobType: JobType, payload: unknown): Promise<void> {
  switch (jobType) {
    case 'catalog.sync.full_summary':
    case 'catalog.sync.group_detail':
    case 'reconcile.group':
    case 'screens.banner_refresh':
    case 'screens.banner_health_maintenance':
    case 'screens.enable_healthy_banners':
    case 'screens.bronx_midtown_image_clone':
    case 'screens.midtown_priced_to_move_promo_rebind':
    case 'screens.midtown_fresh_and_intense_promo_rebind':
    case 'config.workers.stock_refresh':
      await assertSweedReady()
      return
    case 'proposal.generate.description_batch': {
      const parsedPayload = ProposalGenerateDescriptionBatchJobPayloadSchema.parse(payload)
      await assertBedrockReady('Description generation')
      if (parsedPayload.forceLiveRefresh) {
        await assertSweedReady()
      }
      return
    }
    case 'proposal.generate.pricing_batch': {
      const parsedPayload = ProposalGeneratePricingBatchJobPayloadSchema.parse(payload)
      await assertBedrockReady('Pricing market-search adaptation')
      await assertLitAlertsReady('Pricing market research')
      if (parsedPayload.forceLiveRefresh) {
        await assertSweedReady()
      }
      return
    }
    case 'llm.debug.rerun': {
      const parsedPayload = LlmDebugRerunJobPayloadSchema.parse(payload)
      if (parsedPayload.purpose !== 'pricing') {
        await assertBedrockReady('Description reruns')
      }
      if (parsedPayload.forceLiveRefresh) {
        await assertSweedReady()
      }
      return
    }
    case 'scheduling.extract_constraints': {
      SchedulingExtractConstraintsJobPayloadSchema.parse(payload)
      await assertBedrockReady('Scheduling constraint extraction')
      return
    }
    case 'scheduling.generate_candidates':
    case 'proposal.import.review_json':
    case 'undo.execute':
      return
  }
}

async function assertSweedReady(): Promise<void> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new DependencyUnavailableWorkerError(
      'SWEED_AUTH_TOKEN is not configured. Sweed-backed jobs will remain queued until the automation token is available.',
      { delayMs: DEPENDENCY_RETRY_DELAY_MS },
    )
  }

  const now = Date.now()
  if (cachedSweedHealth && now - cachedSweedHealth.checkedAt < SWEED_HEALTH_CACHE_TTL_MS) {
    if (!cachedSweedHealth.errorMessage) {
      return
    }

    throw new DependencyUnavailableWorkerError(cachedSweedHealth.errorMessage, {
      delayMs: DEPENDENCY_RETRY_DELAY_MS,
    })
  }

  try {
    await verifySweedSession()
    cachedSweedHealth = { checkedAt: now, errorMessage: null }
  } catch (error) {
    const message =
      error instanceof Error
        ? `Sweed automation verification failed: ${error.message}`
        : 'Sweed automation verification failed.'
    cachedSweedHealth = { checkedAt: now, errorMessage: message }
    throw new DependencyUnavailableWorkerError(message, { delayMs: DEPENDENCY_RETRY_DELAY_MS })
  }
}

async function assertBedrockReady(scope: string): Promise<void> {
  if (getWorkerEnv().bedrockMantleBearerToken) {
    return
  }

  throw new DependencyUnavailableWorkerError(
    `${scope} is unavailable because BEDROCK_MANTLE_BEARER_TOKEN is not configured. The job will stay queued until Bedrock is ready.`,
    { delayMs: DEPENDENCY_RETRY_DELAY_MS },
  )
}

async function assertLitAlertsReady(scope: string): Promise<void> {
  if (getWorkerEnv().litAlertsBearerToken) {
    return
  }

  throw new DependencyUnavailableWorkerError(
    `${scope} is unavailable because LITALERTS_BEARER_TOKEN is not configured. The job will stay queued until Lit Alerts is ready.`,
    { delayMs: DEPENDENCY_RETRY_DELAY_MS },
  )
}
