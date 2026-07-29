import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const POSTGRES_URL_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s"'`]+/i
const GOOGLE_OAUTH_CLIENT_JSON_ENV_NAMES = new Set([
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
])

function getDefaultSecretRoots(): string[] {
  return Array.from(new Set(['/Users/amp-local/.secret', join(homedir(), '.secret')]))
}

export function buildDefaultSecretFilePaths(...relativeFilePaths: string[]): string[] {
  return getDefaultSecretRoots().flatMap((rootPath) => relativeFilePaths.map((relativeFilePath) => join(rootPath, relativeFilePath)))
}

export function readOptionalEnv(name: string): string | null {
  const directValue = process.env[name]?.trim()
  if (directValue) {
    return directValue
  }

  const filePath = process.env[`${name}_FILE`]?.trim()
  if (!filePath) {
    return null
  }

  const fileValue = readEnvValueFromFile(filePath, name)
  return fileValue || null
}

export function readOptionalSecretEnv(name: string, options?: { defaultFilePaths?: string[] }): string | null {
  const configuredValue = readOptionalEnv(name)
  if (configuredValue) {
    return configuredValue
  }

  const defaultFilePaths = options?.defaultFilePaths ?? []
  for (const filePath of defaultFilePaths) {
    try {
      const fileValue = readEnvValueFromFile(filePath, name)
      if (fileValue) {
        return fileValue
      }
    } catch {
      continue
    }
  }

  return null
}

export function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name)
  if (!value) {
    throw new Error(`${name} is required.`)
  }
  return value
}

export function readRequiredDatabaseUrl(): string {
  const configuredUrl = readOptionalEnv('DATABASE_URL')
  if (configuredUrl) {
    return configuredUrl
  }

  const tigerDataCredentialsFile = readTigerDataCredentialsFile()
  if (!tigerDataCredentialsFile) {
    throw new Error(
      'DATABASE_URL is required. Set DATABASE_URL or DATABASE_URL_FILE, or provide TIGERDATA_CREDENTIALS_FILE, or place a single TigerData credentials file under /Users/amp-local/.secret/tigerdata.',
    )
  }

  const databaseUrl = extractPostgresUrl(readFileSync(tigerDataCredentialsFile, 'utf8'))
  if (!databaseUrl) {
    throw new Error(
      `Could not extract a Postgres URL from ${tigerDataCredentialsFile}. Set DATABASE_URL, DATABASE_URL_FILE, or TIGERDATA_CREDENTIALS_FILE explicitly.`,
    )
  }

  return databaseUrl
}

/**
 * Resolve the dedicated production read-only database credential.
 *
 * This deliberately never falls back to DATABASE_URL or the general
 * TigerData credential bundle. Agent/headless read paths must fail closed
 * instead of silently escalating to the write-capable Helios credential.
 */
export function readRequiredReadOnlyDatabaseUrl(): string {
  const databaseUrl = readOptionalSecretEnv('HELIOS_READONLY_DATABASE_URL', {
    defaultFilePaths: buildDefaultSecretFilePaths('tigerdata/helios-readonly-url'),
  })
  if (!databaseUrl) {
    throw new Error(
      'HELIOS_READONLY_DATABASE_URL is required. Set it directly, set HELIOS_READONLY_DATABASE_URL_FILE, or provision ~/.secret/tigerdata/helios-readonly-url. The read-only loader never falls back to DATABASE_URL.',
    )
  }
  return validateReadOnlyDatabaseUrl(databaseUrl)
}

export function validateReadOnlyDatabaseUrl(databaseUrl: string): string {
  if (databaseUrl.trim() !== databaseUrl || /\s/.test(databaseUrl)) {
    throw new Error('HELIOS_READONLY_DATABASE_URL must not contain whitespace.')
  }

  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('HELIOS_READONLY_DATABASE_URL must be a valid PostgreSQL URL.')
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('HELIOS_READONLY_DATABASE_URL must use postgres:// or postgresql://.')
  }
  if (
    decodeURIComponent(parsed.username) !== 'helios_agent_readonly' ||
    decodeURIComponent(parsed.pathname) !== '/tsdb'
  ) {
    throw new Error(
      'HELIOS_READONLY_DATABASE_URL must authenticate as helios_agent_readonly against /tsdb.',
    )
  }
  if (!parsed.hostname || !parsed.password) {
    throw new Error('HELIOS_READONLY_DATABASE_URL must include a hostname and credential.')
  }
  return databaseUrl
}

export function extractPostgresUrl(contents: string): string | null {
  const match = contents.match(POSTGRES_URL_PATTERN)
  return match?.[0] ?? null
}

export function extractEnvAssignmentValue(contents: string, name: string): string | null {
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(name)}\\s*=\\s*(.+)$`, 'm')
  const match = contents.match(pattern)
  if (!match) {
    return null
  }

  const rawValue = match[1]?.trim() ?? ''
  if (!rawValue) {
    return ''
  }

  const quote = rawValue[0]
  if ((quote === '"' || quote === "'") && rawValue.length > 1) {
    const closingQuoteIndex = rawValue.indexOf(quote, 1)
    if (closingQuoteIndex > 0) {
      return rawValue.slice(1, closingQuoteIndex).trim()
    }
  }

  return rawValue.replace(/\s+#.*$/, '').trim()
}

function readEnvValueFromFile(filePath: string, name: string): string | null {
  const contents = readFileSync(filePath, 'utf8')
  const assignmentValue = extractEnvAssignmentValue(contents, name)
  if (assignmentValue !== null) {
    return assignmentValue || null
  }

  const googleOAuthJsonValue = extractGoogleOAuthClientJsonValue(contents, name)
  if (googleOAuthJsonValue !== null) {
    return googleOAuthJsonValue || null
  }

  if (filePath.toLowerCase().endsWith('.env')) {
    return null
  }

  const trimmed = contents.trim()
  return trimmed || null
}

function extractGoogleOAuthClientJsonValue(contents: string, name: string): string | null {
  if (!GOOGLE_OAUTH_CLIENT_JSON_ENV_NAMES.has(name)) {
    return null
  }

  let parsedContents: unknown
  try {
    parsedContents = JSON.parse(contents)
  } catch {
    return null
  }

  const webConfig = readObjectProperty(parsedContents, 'web')
  if (!webConfig) {
    return null
  }

  switch (name) {
    case 'GOOGLE_OAUTH_CLIENT_ID':
      return readStringProperty(webConfig, 'client_id')
    case 'GOOGLE_OAUTH_CLIENT_SECRET':
      return readStringProperty(webConfig, 'client_secret')
    case 'GOOGLE_OAUTH_REDIRECT_URI':
      return readSingleStringArrayEntry(webConfig, 'redirect_uris')
    default:
      return null
  }
}

function readObjectProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const propertyValue = (value as Record<string, unknown>)[key]
  if (!propertyValue || typeof propertyValue !== 'object' || Array.isArray(propertyValue)) {
    return null
  }

  return propertyValue as Record<string, unknown>
}

function readStringProperty(value: Record<string, unknown>, key: string): string | null {
  const propertyValue = value[key]
  if (typeof propertyValue !== 'string') {
    return null
  }

  const trimmedValue = propertyValue.trim()
  return trimmedValue || null
}

function readSingleStringArrayEntry(value: Record<string, unknown>, key: string): string | null {
  const propertyValue = value[key]
  if (!Array.isArray(propertyValue)) {
    return null
  }

  const entries = propertyValue
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (entries.length !== 1) {
    return null
  }

  return entries[0] ?? null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readTigerDataCredentialsFile(): string | null {
  const configuredPath = readOptionalEnv('TIGERDATA_CREDENTIALS_FILE')
  if (configuredPath) {
    return configuredPath
  }

  const candidateDirectories = getDefaultSecretRoots().map((rootPath) => join(rootPath, 'tigerdata'))

  const candidates = candidateDirectories.flatMap((directoryPath) => {
    try {
      return readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(directoryPath, entry.name))
    } catch {
      return []
    }
  })

  if (candidates.length === 0) {
    return null
  }

  if (candidates.length === 1) {
    return candidates[0] ?? null
  }

  const hintedCandidates = candidates.filter((candidatePath) => {
    const fileName = basename(candidatePath).toLowerCase()
    return fileName.includes('credential') || fileName.endsWith('.txt')
  })

  if (hintedCandidates.length === 1) {
    return hintedCandidates[0] ?? null
  }

  throw new Error(
    `Multiple TigerData credential files were found (${candidates.map((candidatePath) => basename(candidatePath)).join(', ')}). Set TIGERDATA_CREDENTIALS_FILE to the intended file.`,
  )
}
