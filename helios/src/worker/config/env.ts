import {
  buildDefaultSecretFilePaths,
  readOptionalSecretEnv,
  readOptionalEnv,
  readRequiredDatabaseUrl,
} from '../../shared/config/runtimeEnv.js'

const BEDROCK_MANTLE_BEARER_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'bedrock/mantle-bearer-token',
  'bedrock/mantle-bearer-token.env',
)

const LITALERTS_BEARER_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths(
  'litalerts/bearer-token',
  'litalerts/bearer-token.env',
)

const SWEED_AUTH_TOKEN_SECRET_FILE_PATHS = buildDefaultSecretFilePaths('sweed/auth-token', 'sweed/auth-token.env')

export interface WorkerEnv {
  bedrockMantleBaseUrl: string
  bedrockMantleBearerToken: string | null
  databaseUrl: string
  llmRequestTimeoutMs: number
  litAlertsApiUrl: string
  litAlertsBearerToken: string | null
  litAlertsMidtownDispensaryIds: number[]
  litAlertsRequestTimeoutMs: number
  litAlertsStateCode: string
  litAlertsStateId: number
  pollIntervalMs: number
  sweedApiUrl: string
  sweedAuthToken: string | null
  sweedRequestTimeoutMs: number
  sweedStateDealerId: number
  workerMaxAttempts: number
  workerMaxConcurrentJobs: number
  workerRetryBaseDelayMs: number
}

let cachedEnv: WorkerEnv | null = null

export function getWorkerEnv(): WorkerEnv {
  if (cachedEnv !== null) {
    return cachedEnv
  }

  cachedEnv = {
    bedrockMantleBaseUrl: readOptionalEnv('BEDROCK_MANTLE_BASE_URL') ?? 'https://bedrock-mantle.us-east-2.api.aws/v1',
    bedrockMantleBearerToken: readOptionalSecretEnv('BEDROCK_MANTLE_BEARER_TOKEN', {
      defaultFilePaths: BEDROCK_MANTLE_BEARER_TOKEN_SECRET_FILE_PATHS,
    }),
    databaseUrl: readRequiredDatabaseUrl(),
    llmRequestTimeoutMs: readNumberEnv('LLM_REQUEST_TIMEOUT_MS', 120000),
    litAlertsApiUrl: readOptionalEnv('LITALERTS_API_URL') ?? 'https://public-api.litalerts.com',
    litAlertsBearerToken: readOptionalSecretEnv('LITALERTS_BEARER_TOKEN', {
      defaultFilePaths: LITALERTS_BEARER_TOKEN_SECRET_FILE_PATHS,
    }),
    litAlertsMidtownDispensaryIds: readNumberListEnv(
      'LITALERTS_MIDTOWN_DISPENSARY_IDS',
      [27370, 15586, 24859, 45286, 16777, 28688, 23215, 23312, 18589, 40539, 44065, 35453, 36607],
    ),
    litAlertsRequestTimeoutMs: readNumberEnv('LITALERTS_REQUEST_TIMEOUT_MS', 30000),
    litAlertsStateCode: readOptionalEnv('LITALERTS_STATE_CODE') ?? 'NY',
    litAlertsStateId: readNumberEnv('LITALERTS_STATE_ID', 265),
    pollIntervalMs: readNumberEnv('WORKER_POLL_INTERVAL_MS', 3000),
    sweedApiUrl: readOptionalEnv('SWEED_API_URL') ?? 'https://prime.sweedpos.com/api/',
    sweedAuthToken: readOptionalSecretEnv('SWEED_AUTH_TOKEN', {
      defaultFilePaths: SWEED_AUTH_TOKEN_SECRET_FILE_PATHS,
    }),
    sweedRequestTimeoutMs: readNumberEnv('SWEED_REQUEST_TIMEOUT_MS', 30000),
    sweedStateDealerId: readNumberEnv('SWEED_STATE_DEALER_ID', 210248),
    workerMaxAttempts: readNumberEnv('WORKER_MAX_ATTEMPTS', 5),
    workerMaxConcurrentJobs: readNumberEnv('WORKER_MAX_CONCURRENT_JOBS', 2),
    workerRetryBaseDelayMs: readNumberEnv('WORKER_RETRY_BASE_DELAY_MS', 5000),
  }

  return cachedEnv
}

function readNumberEnv(name: string, fallback: number): number {
  const rawValue = readOptionalEnv(name)
  if (rawValue === null) {
    return fallback
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid integer.`)
  }
  return parsed
}

function readNumberListEnv(name: string, fallback: number[]): number[] {
  const rawValue = readOptionalEnv(name)
  if (rawValue === null) {
    return fallback
  }

  return rawValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must contain only comma-separated integers.`)
      }
      return parsed
    })
}
