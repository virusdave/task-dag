import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const AGENT_READONLY_HEADER_NAMES = {
  keyId: 'x-helios-agent-key-id',
  ruleId: 'x-helios-agent-rule-id',
  timestamp: 'x-helios-agent-timestamp',
  nonce: 'x-helios-agent-nonce',
  signature: 'x-helios-agent-signature',
} as const

const CANONICAL_PAYLOAD_VERSION = 'helios-agent-readonly-v1'
const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const SAFE_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/
const DEFAULT_TIMESTAMP_SKEW_SECONDS = 90
const DEFAULT_NONCE_TTL_SECONDS = 180
const DEFAULT_NONCE_CACHE_SIZE = 10_000
const DEFAULT_RESPONSE_CAP_BYTES = 1_048_576
const MAX_RESPONSE_CAP_BYTES = 10_485_760

export type AgentReadonlyDenyReason =
  | 'not_configured'
  | 'configuration_invalid'
  | 'not_signed_agent_request'
  | 'mixed_credentials'
  | 'method_not_allowed'
  | 'missing_header'
  | 'duplicate_header'
  | 'invalid_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_range'
  | 'nonce_replay'
  | 'unknown_key'
  | 'unknown_rule'
  | 'inactive_rule'
  | 'ambiguous_path'
  | 'path_not_allowed'
  | 'invalid_signature'

export type AgentReadonlyAllowedMethod = 'GET' | 'HEAD'
export type AgentReadonlyRuleMethod = 'GET' | 'HEAD'
export type AgentReadonlyPathKind = 'page' | 'api' | 'asset' | 'session'
export type AgentReadonlyPathMatch = 'exact' | 'prefix'

export interface AgentReadonlyPublicKeyConfig {
  id: string
  publicKey: string
}

export interface AgentReadonlyPathRule {
  method: AgentReadonlyRuleMethod
  kind: AgentReadonlyPathKind
  match: AgentReadonlyPathMatch
  path: string
  safeReadNote: string
}

export interface AgentReadonlyAllowlistRule {
  id: string
  owner: string
  reason: string
  notBefore: Date
  notAfter: Date
  maxResponseBytes: number
  paths: AgentReadonlyPathRule[]
}

export type AgentReadonlyConfig =
  | {
      enabled: false
      configurationIssue: string
      timestampSkewMs: number
      nonceTtlMs: number
      nonceCacheSize: number
      defaultMaxResponseBytes: number
      maxResponseBytes: number
    }
  | {
      enabled: true
      publicKeys: AgentReadonlyPublicKeyConfig[]
      allowlistRules: AgentReadonlyAllowlistRule[]
      timestampSkewMs: number
      nonceTtlMs: number
      nonceCacheSize: number
      defaultMaxResponseBytes: number
      maxResponseBytes: number
    }

export interface AgentReadonlyRequestLike {
  method: string
  host: string | undefined
  pathAndQuery: string
  headers: Record<string, string | string[] | undefined>
}

export type AgentReadonlyVerificationResult =
  | {
      ok: true
      keyId: string
      ruleId: string
      method: AgentReadonlyAllowedMethod
      host: string
      pathAndQuery: string
      timestamp: string
      nonce: string
      canonicalPayload: string
      pathRule: AgentReadonlyPathRule
      maxResponseBytes: number
    }
  | {
      ok: false
      reason: AgentReadonlyDenyReason
      statusCode: 401 | 403
      keyId?: string
      ruleId?: string
      method?: string
      pathAndQuery?: string
      detail?: string
    }

export function parseAgentReadonlyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentReadonlyConfig {
  try {
    const timestampSkewSeconds = readPositiveIntegerEnv(
      env,
      'HELIOS_AGENT_READONLY_TIMESTAMP_SKEW_SECONDS',
      DEFAULT_TIMESTAMP_SKEW_SECONDS,
    )
    const nonceTtlSeconds = readPositiveIntegerEnv(
      env,
      'HELIOS_AGENT_READONLY_NONCE_TTL_SECONDS',
      Math.max(DEFAULT_NONCE_TTL_SECONDS, timestampSkewSeconds * 2),
    )
    const nonceCacheSize = readPositiveIntegerEnv(
      env,
      'HELIOS_AGENT_READONLY_NONCE_CACHE_SIZE',
      DEFAULT_NONCE_CACHE_SIZE,
    )
    const defaultMaxResponseBytes = readPositiveIntegerEnv(
      env,
      'HELIOS_AGENT_READONLY_DEFAULT_MAX_RESPONSE_BYTES',
      DEFAULT_RESPONSE_CAP_BYTES,
    )
    const maxResponseBytes = readPositiveIntegerEnv(
      env,
      'HELIOS_AGENT_READONLY_MAX_RESPONSE_BYTES',
      MAX_RESPONSE_CAP_BYTES,
    )

    const disabledBase = {
      enabled: false as const,
      timestampSkewMs: timestampSkewSeconds * 1000,
      nonceTtlMs: nonceTtlSeconds * 1000,
      nonceCacheSize,
      defaultMaxResponseBytes,
      maxResponseBytes,
    }

    if (defaultMaxResponseBytes > maxResponseBytes) {
      return {
        ...disabledBase,
        configurationIssue:
          'HELIOS_AGENT_READONLY_DEFAULT_MAX_RESPONSE_BYTES must be less than or equal to HELIOS_AGENT_READONLY_MAX_RESPONSE_BYTES.',
      }
    }

    const publicKeysRaw = readJsonConfigValue(env, 'HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON')
    const allowlistRaw =
      readJsonConfigValue(env, 'HELIOS_AGENT_READONLY_ALLOWLIST_JSON') ??
      readPathConfigValue(env, 'HELIOS_AGENT_READONLY_ALLOWLIST_PATH')

    if (publicKeysRaw === null || allowlistRaw === null) {
      return {
        ...disabledBase,
        configurationIssue:
          'Signed-agent readonly access is disabled until public keys and allowlist JSON are configured.',
      }
    }

    const publicKeys = parsePublicKeys(JSON.parse(publicKeysRaw))
    const allowlistRules = parseAllowlistRules(JSON.parse(allowlistRaw), {
      defaultMaxResponseBytes,
      maxResponseBytes,
    })
    if (publicKeys.length === 0 || allowlistRules.length === 0) {
      return {
        ...disabledBase,
        configurationIssue: 'Signed-agent readonly config must include at least one key and one allowlist rule.',
      }
    }
    return {
      enabled: true,
      publicKeys,
      allowlistRules,
      timestampSkewMs: timestampSkewSeconds * 1000,
      nonceTtlMs: nonceTtlSeconds * 1000,
      nonceCacheSize,
      defaultMaxResponseBytes,
      maxResponseBytes,
    }
  } catch (error) {
    return {
      enabled: false,
      timestampSkewMs: DEFAULT_TIMESTAMP_SKEW_SECONDS * 1000,
      nonceTtlMs: DEFAULT_NONCE_TTL_SECONDS * 1000,
      nonceCacheSize: DEFAULT_NONCE_CACHE_SIZE,
      defaultMaxResponseBytes: DEFAULT_RESPONSE_CAP_BYTES,
      maxResponseBytes: MAX_RESPONSE_CAP_BYTES,
      configurationIssue: error instanceof Error ? error.message : 'Signed-agent readonly config is invalid.',
    }
  }
}

export function createAgentReadonlyVerifier(config: AgentReadonlyConfig): {
  verify(request: AgentReadonlyRequestLike, now?: Date): AgentReadonlyVerificationResult
} {
  const nonceCache = new NonceReplayCache(config.nonceTtlMs, config.nonceCacheSize)
  const publicKeys = new Map(
    config.enabled
      ? config.publicKeys.map((entry) => [entry.id, createEd25519PublicKey(entry.publicKey)] as const)
      : [],
  )

  return {
    verify(request, now = new Date()) {
      return verifyAgentReadonlyRequest(request, config, nonceCache, publicKeys, now)
    },
  }
}

export function buildAgentReadonlyCanonicalPayload(input: {
  method: AgentReadonlyAllowedMethod
  host: string
  pathAndQuery: string
  keyId: string
  ruleId: string
  timestamp: string
  nonce: string
}): string {
  return [
    CANONICAL_PAYLOAD_VERSION,
    `method:${input.method}`,
    `host:${input.host}`,
    `path:${input.pathAndQuery}`,
    `key_id:${input.keyId}`,
    `rule_id:${input.ruleId}`,
    `timestamp:${input.timestamp}`,
    `nonce:${input.nonce}`,
  ].join('\n')
}

export function isSignedAgentReadonlyRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return Object.values(AGENT_READONLY_HEADER_NAMES).some((headerName) => getHeader(headers, headerName) !== undefined)
}

function verifyAgentReadonlyRequest(
  request: AgentReadonlyRequestLike,
  config: AgentReadonlyConfig,
  nonceCache: NonceReplayCache,
  publicKeys: Map<string, ReturnType<typeof createPublicKey>>,
  now: Date,
): AgentReadonlyVerificationResult {
  const method = request.method.toUpperCase()
  const pathAndQuery = request.pathAndQuery

  if (!isSignedAgentReadonlyRequest(request.headers)) {
    return deny('not_signed_agent_request', 401, { method, pathAndQuery })
  }
  if (!config.enabled) {
    return deny('not_configured', 403, { method, pathAndQuery, detail: config.configurationIssue })
  }
  if (getHeader(request.headers, 'cookie') !== undefined || getHeader(request.headers, 'authorization') !== undefined) {
    return deny('mixed_credentials', 403, { method, pathAndQuery })
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return deny('method_not_allowed', 403, { method, pathAndQuery })
  }

  const headers = readRequiredAgentHeaders(request.headers)
  if (!headers.ok) {
    return deny(headers.reason, 401, { method, pathAndQuery, detail: headers.detail })
  }

  const keyId = headers.keyId
  const ruleId = headers.ruleId
  if (!isSafeToken(keyId) || !isSafeToken(ruleId) || !isSafeNonce(headers.nonce)) {
    return deny('invalid_header', 401, { keyId, ruleId, method, pathAndQuery })
  }

  const timestamp = parseRequestTimestamp(headers.timestamp)
  if (timestamp === null) {
    return deny('invalid_timestamp', 401, { keyId, ruleId, method, pathAndQuery })
  }
  if (Math.abs(now.getTime() - timestamp.getTime()) > config.timestampSkewMs) {
    return deny('timestamp_out_of_range', 401, { keyId, ruleId, method, pathAndQuery })
  }
  if (nonceCache.has(keyId, headers.nonce, now)) {
    return deny('nonce_replay', 401, { keyId, ruleId, method, pathAndQuery })
  }

  const publicKey = publicKeys.get(keyId)
  if (!publicKey) {
    return deny('unknown_key', 403, { keyId, ruleId, method, pathAndQuery })
  }
  const rule = config.allowlistRules.find((entry) => entry.id === ruleId)
  if (!rule) {
    return deny('unknown_rule', 403, { keyId, ruleId, method, pathAndQuery })
  }
  if (timestamp < rule.notBefore || timestamp > rule.notAfter) {
    return deny('inactive_rule', 403, { keyId, ruleId, method, pathAndQuery })
  }
  if (!isUnambiguousPathAndQuery(pathAndQuery)) {
    return deny('ambiguous_path', 403, { keyId, ruleId, method, pathAndQuery })
  }

  const pathRule = findAllowedPathRule(rule, method as AgentReadonlyAllowedMethod, pathAndQuery)
  if (!pathRule) {
    return deny('path_not_allowed', 403, { keyId, ruleId, method, pathAndQuery })
  }

  const host = request.host?.trim().toLowerCase()
  if (!host || /[\s/]/.test(host)) {
    return deny('invalid_header', 401, { keyId, ruleId, method, pathAndQuery })
  }
  const canonicalPayload = buildAgentReadonlyCanonicalPayload({
    method: method as AgentReadonlyAllowedMethod,
    host,
    pathAndQuery,
    keyId,
    ruleId,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
  })
  const signature = decodeBase64Url(headers.signature)
  if (!signature || signature.length !== 64) {
    return deny('invalid_header', 401, { keyId, ruleId, method, pathAndQuery })
  }
  if (!verifySignature(null, Buffer.from(canonicalPayload, 'utf8'), publicKey, signature)) {
    return deny('invalid_signature', 401, { keyId, ruleId, method, pathAndQuery })
  }

  nonceCache.remember(keyId, headers.nonce, now)
  return {
    ok: true,
    keyId,
    ruleId,
    method: method as AgentReadonlyAllowedMethod,
    host,
    pathAndQuery,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    canonicalPayload,
    pathRule,
    maxResponseBytes: rule.maxResponseBytes,
  }
}

function readRequiredAgentHeaders(
  headers: Record<string, string | string[] | undefined>,
):
  | {
      ok: true
      keyId: string
      ruleId: string
      timestamp: string
      nonce: string
      signature: string
    }
  | { ok: false; reason: 'missing_header' | 'duplicate_header'; detail: string } {
  const values: Record<keyof typeof AGENT_READONLY_HEADER_NAMES, string> = {
    keyId: '',
    ruleId: '',
    timestamp: '',
    nonce: '',
    signature: '',
  }
  for (const [field, headerName] of Object.entries(AGENT_READONLY_HEADER_NAMES) as Array<
    [keyof typeof AGENT_READONLY_HEADER_NAMES, string]
  >) {
    const value = getHeader(headers, headerName)
    if (Array.isArray(value)) {
      return { ok: false, reason: 'duplicate_header', detail: headerName }
    }
    if (value === undefined || value.trim().length === 0) {
      return { ok: false, reason: 'missing_header', detail: headerName }
    }
    values[field] = value.trim()
  }
  return { ok: true, ...values }
}

function parsePublicKeys(raw: unknown): AgentReadonlyPublicKeyConfig[] {
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.entries(raw).map(([id, publicKey]) => ({ id, public_key: publicKey }))
      : null
  if (!entries) {
    throw new Error('HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON must be an array or object map.')
  }
  const seen = new Set<string>()
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Signed-agent public key at index ${index} must be an object.`)
    }
    const id = readRequiredString(entry, 'id')
    const publicKey = readRequiredString(entry, 'public_key', 'publicKey')
    if (!isSafeToken(id)) {
      throw new Error(`Signed-agent public key id ${id} contains unsupported characters.`)
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate signed-agent public key id ${id}.`)
    }
    seen.add(id)
    createEd25519PublicKey(publicKey)
    return { id, publicKey }
  })
}

function parseAllowlistRules(
  raw: unknown,
  limits: { defaultMaxResponseBytes: number; maxResponseBytes: number },
): AgentReadonlyAllowlistRule[] {
  const entries = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Signed-agent allowlist rule at index ${index} must be an object.`)
    }
    const id = readRequiredString(entry, 'id')
    if (!isSafeToken(id)) {
      throw new Error(`Signed-agent allowlist rule id ${id} contains unsupported characters.`)
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate signed-agent allowlist rule id ${id}.`)
    }
    seen.add(id)
    const notBefore = parseConfigTimestamp(readRequiredString(entry, 'not_before', 'notBefore'), `${id}.not_before`)
    const notAfter = parseConfigTimestamp(readRequiredString(entry, 'not_after', 'notAfter'), `${id}.not_after`)
    if (notBefore >= notAfter) {
      throw new Error(`Signed-agent allowlist rule ${id} has not_before >= not_after.`)
    }
    const maxResponseBytes = readPositiveInteger(
      entry.max_response_bytes ?? entry.maxResponseBytes ?? limits.defaultMaxResponseBytes,
      `${id}.max_response_bytes`,
    )
    if (maxResponseBytes > limits.maxResponseBytes) {
      throw new Error(`Signed-agent allowlist rule ${id} exceeds the configured max response cap.`)
    }
    const paths = parsePathRules(entry.paths, id)
    return {
      id,
      owner: readRequiredString(entry, 'owner'),
      reason: readRequiredString(entry, 'reason'),
      notBefore,
      notAfter,
      maxResponseBytes,
      paths,
    }
  })
}

function parsePathRules(raw: unknown, ruleId: string): AgentReadonlyPathRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Signed-agent allowlist rule ${ruleId} must include at least one path.`)
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Signed-agent path rule ${ruleId}.paths[${index}] must be an object.`)
    }
    const method = readRequiredString(entry, 'method').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error(`Signed-agent path rule ${ruleId}.paths[${index}] must use GET or HEAD.`)
    }
    const kind = readRequiredString(entry, 'kind')
    if (!['page', 'api', 'asset', 'session'].includes(kind)) {
      throw new Error(`Signed-agent path rule ${ruleId}.paths[${index}] has an unknown kind.`)
    }
    const match = readRequiredString(entry, 'match')
    if (match !== 'exact' && match !== 'prefix') {
      throw new Error(`Signed-agent path rule ${ruleId}.paths[${index}] has an unknown match type.`)
    }
    if (match === 'prefix' && kind !== 'asset') {
      throw new Error(
        `Signed-agent prefix path rule ${ruleId}.paths[${index}] must be limited to asset routes; API and page routes need exact safe-read entries.`,
      )
    }
    const path = readRequiredString(entry, 'path')
    if (!isAllowedRulePath(path)) {
      throw new Error(`Signed-agent path rule ${ruleId}.paths[${index}] has an invalid path.`)
    }
    if (match === 'prefix' && !path.endsWith('/')) {
      throw new Error(`Signed-agent prefix path rule ${ruleId}.paths[${index}] must end with '/'.`)
    }
    return {
      method,
      kind: kind as AgentReadonlyPathKind,
      match,
      path,
      safeReadNote: readRequiredString(entry, 'safe_read_note', 'safeReadNote'),
    }
  })
}

function findAllowedPathRule(
  rule: AgentReadonlyAllowlistRule,
  requestMethod: AgentReadonlyAllowedMethod,
  pathAndQuery: string,
): AgentReadonlyPathRule | null {
  const pathOnly = stripQuery(pathAndQuery)
  return (
    rule.paths.find((pathRule) => {
      const methodMatches = pathRule.method === requestMethod || (requestMethod === 'HEAD' && pathRule.method === 'GET')
      if (!methodMatches) {
        return false
      }
      if (pathRule.match === 'exact') {
        return pathAndQuery === pathRule.path || pathOnly === pathRule.path
      }
      return pathOnly.startsWith(pathRule.path)
    }) ?? null
  )
}

function createEd25519PublicKey(publicKey: string): ReturnType<typeof createPublicKey> {
  const keyBytes = decodeBase64Url(publicKey)
  if (!keyBytes || keyBytes.length !== 32) {
    throw new Error('Signed-agent Ed25519 public keys must be 32-byte base64url values.')
  }
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_DER_PREFIX, keyBytes]), format: 'der', type: 'spki' })
}

function parseRequestTimestamp(raw: string): Date | null {
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(seconds)) return null
    return new Date(seconds * 1000)
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) {
    return null
  }
  const parsed = new Date(raw)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function parseConfigTimestamp(raw: string, field: string): Date {
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Signed-agent ${field} must be a valid timestamp.`)
  }
  return parsed
}

function isUnambiguousPathAndQuery(pathAndQuery: string): boolean {
  if (!pathAndQuery.startsWith('/') || pathAndQuery.includes('#') || pathAndQuery.includes('\\')) {
    return false
  }
  if (/[\u0000-\u001F\u007F ]/.test(pathAndQuery)) {
    return false
  }
  if (/%(?:2f|5c)/i.test(pathAndQuery) || /%(?![0-9A-Fa-f]{2})/.test(pathAndQuery)) {
    return false
  }
  try {
    const parsed = new URL(pathAndQuery, 'https://helios.invalid')
    return `${parsed.pathname}${parsed.search}` === pathAndQuery
  } catch {
    return false
  }
}

function isAllowedRulePath(path: string): boolean {
  return path.startsWith('/') && !path.includes('?') && !path.includes('#') && isUnambiguousPathAndQuery(path)
}

function stripQuery(pathAndQuery: string): string {
  const queryIndex = pathAndQuery.indexOf('?')
  return queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex)
}

function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value) || value.length === 0) {
    return null
  }
  try {
    const decoded = Buffer.from(value, 'base64url')
    const withoutPadding = value.replace(/=+$/, '')
    if (decoded.toString('base64url') !== withoutPadding) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | string[] | undefined {
  const direct = headers[name]
  if (direct !== undefined) {
    return direct
  }
  const lowerName = name.toLowerCase()
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName)
  return matchingKey ? headers[matchingKey] : undefined
}

function deny(
  reason: AgentReadonlyDenyReason,
  statusCode: 401 | 403,
  fields: Omit<Extract<AgentReadonlyVerificationResult, { ok: false }>, 'ok' | 'reason' | 'statusCode'> = {},
): AgentReadonlyVerificationResult {
  return { ok: false, reason, statusCode, ...fields }
}

function isSafeToken(value: string): boolean {
  return SAFE_TOKEN_PATTERN.test(value)
}

function isSafeNonce(value: string): boolean {
  return SAFE_NONCE_PATTERN.test(value)
}

function readJsonConfigValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const directValue = env[name]?.trim()
  if (directValue) {
    return directValue
  }
  const filePath = env[`${name}_FILE`]?.trim()
  if (!filePath) {
    return null
  }
  return readFileSync(filePath, 'utf8').trim() || null
}

function readPathConfigValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const filePath = env[name]?.trim()
  if (!filePath) {
    return null
  }
  return readFileSync(filePath, 'utf8').trim() || null
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const rawValue = env[name]?.trim()
  if (!rawValue) {
    return fallback
  }
  return readPositiveInteger(rawValue, name)
}

function readPositiveInteger(raw: unknown, field: string): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`)
  }
  return value
}

function readRequiredString(record: Record<string, unknown>, primaryName: string, alternateName?: string): string {
  const value = record[primaryName] ?? (alternateName ? record[alternateName] : undefined)
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${primaryName} must be a non-empty string.`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class NonceReplayCache {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  has(keyId: string, nonce: string, now: Date): boolean {
    this.prune(now)
    return this.seen.has(this.cacheKey(keyId, nonce))
  }

  remember(keyId: string, nonce: string, now: Date): void {
    this.prune(now)
    this.seen.set(this.cacheKey(keyId, nonce), now.getTime() + this.ttlMs)
    while (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value as string | undefined
      if (!oldestKey) break
      this.seen.delete(oldestKey)
    }
  }

  private prune(now: Date): void {
    const nowMs = now.getTime()
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key)
      }
    }
  }

  private cacheKey(keyId: string, nonce: string): string {
    return `${keyId}\0${nonce}`
  }
}
