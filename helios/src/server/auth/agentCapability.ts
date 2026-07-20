import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  CAPABILITY_ENVELOPE_MAX_BYTES,
  PostgresCapabilityStateStore,
  type CapabilityAdmissionState,
  type CapabilityStateStore,
} from './agentCapabilityState.js'

const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEX = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const MAX_TTL_SECONDS = 14 * 24 * 60 * 60
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DEFAULT_TTL_SECONDS = 4 * 60 * 60
const REQUEST_SKEW_MS = 90_000

export const AGENT_CAPABILITY_HEADERS = {
  keyId: 'x-helios-agent-capability-key-id',
  grantId: 'x-helios-agent-capability-grant-id',
  actionId: 'x-helios-agent-capability-action-id',
  timestamp: 'x-helios-agent-capability-timestamp',
  nonce: 'x-helios-agent-capability-nonce',
  idempotencyKey: 'x-helios-agent-capability-idempotency-key',
  bodySha256: 'x-helios-agent-capability-body-sha256',
  signature: 'x-helios-agent-capability-signature',
} as const

export const AGENT_WASTE_CLUSTER_DESCRIPTOR = {
  action_id: 'agent-waste.cluster.v1',
  body_limit_bytes: 4096,
  body_schema: 'strict-empty-object-v1',
  content_type: 'application/json',
  method: 'POST',
  path: '/api/agent-waste/clusters',
  query_policy: 'none',
  retry_class: 'analysis-idempotent-v1',
} as const

export const AGENT_WASTE_CLUSTER_SPEC_SHA256 = '0090c31b5f120efb18e4564b6fe94569e1618ce223ce4c6a7331afeff0760a5e'

export interface AgentCapabilityActionGrant {
  action_id: string
  spec_sha256: string
  agent_key_ids: string[]
}

export interface AgentCapabilityShape {
  version: 1
  grant_id: string
  issued_at: string
  not_before: string
  expires_at: string
  approved_by: { user_id: number; email: string }
  approval_request_id: string
  actions: AgentCapabilityActionGrant[]
}

export interface AgentCapabilityEnvelope {
  shape: AgentCapabilityShape
  shape_sha256: string
  attestation_key_id: string
  attestation: string
}

export interface AgentCapabilityConfig {
  enabled: boolean
  configurationIssue?: string
  requestKeys: ReadonlyMap<string, KeyObject>
  attestationKeyId?: string
  attestationPublicKey?: KeyObject
  attestationPrivateKey?: KeyObject
  stateStore?: CapabilityStateStore
}

export type CapabilityDenyReason =
  | 'not_configured' | 'mixed_credentials' | 'missing_header' | 'duplicate_header'
  | 'invalid_header' | 'invalid_signature' | 'request_mismatch' | 'timestamp_out_of_range'
  | 'grant_invalid' | 'grant_inactive' | 'grant_revoked' | 'emergency_disabled'
  | 'body_digest_mismatch' | 'nonce_replay' | 'nonce_capacity' | 'action_mismatch'
  | 'guard_not_completed' | 'state_unavailable'

export interface AgentCapabilityPrincipal {
  kind: 'agent_capability'
  keyId: string
  grantId: string
  actionId: string
  timestamp: string
  nonce: string
  idempotencyKey: string
  bodySha256: string
  shapeSha256: string
  shape: AgentCapabilityShape
  pending: true
}

export interface CapabilityAudit {
  outcome: 'pending' | 'accepted' | 'denied'
  reason?: CapabilityDenyReason
  keyId?: string
  grantId?: string
  actionId?: string
  shapeSha256?: string
  specSha256?: string
  timestamp?: string
  nonceHash?: string
  idempotencyKey?: string
  method: string
  path: string
  bodySha256?: string
  statusCode?: number
  approvedBy?: AgentCapabilityShape['approved_by']
  issuedAt?: string
  expiresAt?: string
  executionDisposition?: 'recomputed'
  actionStartedAtMs?: number
  actionOutcome?: 'success' | 'partial' | 'handler_error'
  actionSummary?: {
    inputCount: number
    outputCount: number
    clusterCount: number
    deterministicClusterCount: number
    coverageComplete: boolean
    refinementComplete: boolean
    refinementSucceeded: number
    refinementFailed: number
    refinementSkipped: number
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    agentCapabilityPrincipal?: AgentCapabilityPrincipal
    agentCapabilityAudit?: CapabilityAudit
  }
}

const ShapeSchema = z.object({
  version: z.literal(1), grant_id: z.string().regex(TOKEN), issued_at: z.string().regex(RFC3339),
  not_before: z.string().regex(RFC3339), expires_at: z.string().regex(RFC3339),
  approved_by: z.object({ user_id: z.number().int().positive(), email: z.string().email().max(320) }).strict(),
  approval_request_id: z.string().regex(TOKEN),
  actions: z.array(z.object({
    action_id: z.string().regex(TOKEN), spec_sha256: z.string().regex(HEX),
    agent_key_ids: z.array(z.string().regex(TOKEN)).min(1).max(32),
  }).strict()).min(1).max(32),
}).strict()
const EnvelopeSchema = z.object({
  shape: ShapeSchema, shape_sha256: z.string().regex(HEX),
  attestation_key_id: z.string().regex(TOKEN), attestation: z.string().regex(BASE64URL),
}).strict()

export const CreateCapabilityOverlaySchema = z.object({
  actionIds: z.array(z.string().regex(TOKEN)).min(1).max(32).refine(unique),
  agentKeyIds: z.array(z.string().regex(TOKEN)).min(1).max(32).refine(unique),
  notBefore: z.string().regex(RFC3339).optional(),
  ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
}).strict()

export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS cannot encode a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(',')}}`
  }
  throw new Error('JCS cannot encode this value.')
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildCapabilityCanonicalPayload(input: {
  method: string; host: string; path: string; query: string; contentType: string; bodySha256: string
  keyId: string; grantId: string; actionId: string; timestamp: string; nonce: string; idempotencyKey: string
}): string {
  return ['helios-agent-capability-request-v1', `method:${input.method}`, `host:${input.host}`,
    `path:${input.path}`, `query:${input.query}`, `content_type:${input.contentType}`,
    `body_sha256:${input.bodySha256}`, `key_id:${input.keyId}`, `grant_id:${input.grantId}`,
    `action_id:${input.actionId}`, `timestamp:${input.timestamp}`, `nonce:${input.nonce}`,
    `idempotency_key:${input.idempotencyKey}`].join('\n')
}

export function parseAgentCapabilityConfig(env: NodeJS.ProcessEnv = process.env): AgentCapabilityConfig {
  try {
    const requestKeysRaw = env.HELIOS_AGENT_CAPABILITY_PUBLIC_KEYS_JSON
    const attestationKeyId = env.HELIOS_AGENT_CAPABILITY_ATTESTATION_KEY_ID
    const attestationPublicRaw = env.HELIOS_AGENT_CAPABILITY_ATTESTATION_PUBLIC_KEY
    const attestationPrivateRaw = env.HELIOS_AGENT_CAPABILITY_ATTESTATION_PRIVATE_KEY
    if (!requestKeysRaw || !attestationKeyId || !attestationPublicRaw) {
      return { enabled: false, configurationIssue: 'Signed-agent capability configuration is incomplete.', requestKeys: new Map() }
    }
    if (!TOKEN.test(attestationKeyId)) throw new Error('Invalid attestation key id.')
    const parsed: unknown = JSON.parse(requestKeysRaw)
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) throw new Error('Capability public keyring must be a non-empty object.')
    const requestKeys = new Map<string, KeyObject>()
    for (const [id, raw] of Object.entries(parsed)) {
      if (!TOKEN.test(id) || typeof raw !== 'string' || requestKeys.has(id)) throw new Error('Invalid capability public keyring.')
      requestKeys.set(id, publicKey(raw))
    }
    const attestationPublicKey = publicKey(attestationPublicRaw)
    if ([...requestKeys.values()].some((key) => key.equals(attestationPublicKey))) throw new Error('Attestation key must not equal a request key.')
    const attestationPrivateKey = attestationPrivateRaw ? privateKey(attestationPrivateRaw) : undefined
    if (attestationPrivateKey && !createPublicKey(attestationPrivateKey).equals(attestationPublicKey)) {
      throw new Error('Attestation private and public keys do not match.')
    }
    return { enabled: true, requestKeys, attestationKeyId, attestationPublicKey, attestationPrivateKey }
  } catch (error) {
    return { enabled: false, configurationIssue: error instanceof Error ? error.message : 'Invalid capability configuration.', requestKeys: new Map() }
  }
}

export function createCapabilityService(config: AgentCapabilityConfig, now: () => Date = () => new Date()) {
  const store = config.stateStore ?? productionStateStore

  function loadState(state: CapabilityAdmissionState, grantId: string): AgentCapabilityEnvelope {
    if (state.emergencyDisabled) throw new CapabilityError('emergency_disabled', 403)
    if (!state.grant.present) throw new CapabilityError('grant_revoked', 403)
    if (state.grant.oversized) throw new CapabilityError('grant_invalid', 403)
    try {
      const envelope = EnvelopeSchema.parse(state.grant.value) as AgentCapabilityEnvelope
      validateEnvelope(envelope, config)
      if (envelope.shape.grant_id !== grantId) throw new CapabilityError('grant_invalid', 403)
      return envelope
    } catch (error) {
      if (error instanceof CapabilityError) throw error
      throw new CapabilityError('grant_invalid', 403)
    }
  }

  async function verifyRequest(request: FastifyRequest, appPath: string): Promise<AgentCapabilityPrincipal> {
    const values = readHeaders(request)
    request.agentCapabilityAudit = {
      outcome: 'pending', keyId: values.keyId, grantId: values.grantId, actionId: values.actionId,
      timestamp: values.timestamp, nonceHash: sha256(values.nonce), idempotencyKey: values.idempotencyKey,
      method: request.method, path: appPath, bodySha256: values.bodySha256,
    }
    if (!config.enabled) throw new CapabilityError('not_configured', 403)
    const timestamp = parseTime(values.timestamp)
    if (!timestamp || Math.abs(now().getTime() - timestamp.getTime()) > REQUEST_SKEW_MS) throw new CapabilityError('timestamp_out_of_range', 401)
    const action = AGENT_WASTE_CLUSTER_DESCRIPTOR
    const queryIndex = request.url.indexOf('?')
    const query = queryIndex === -1 ? '' : request.url.slice(queryIndex + 1)
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
    const host = request.headers.host?.trim().toLowerCase() ?? ''
    if (request.method !== action.method || appPath !== action.path || queryIndex !== -1 || contentType !== action.content_type || !validHost(host) || !unambiguousPath(appPath)) {
      throw new CapabilityError('request_mismatch', 403)
    }
    if (values.actionId !== action.action_id) throw new CapabilityError('request_mismatch', 403)
    const key = config.requestKeys.get(values.keyId)
    if (!key) throw new CapabilityError('grant_invalid', 403)
    const payload = buildCapabilityCanonicalPayload({ method: request.method, host, path: appPath, query,
      contentType, bodySha256: values.bodySha256, keyId: values.keyId, grantId: values.grantId,
      actionId: values.actionId, timestamp: values.timestamp, nonce: values.nonce, idempotencyKey: values.idempotencyKey })
    const signature = decode(values.signature, 64)
    if (!signature || !verify(null, Buffer.from(payload), key, signature)) throw new CapabilityError('invalid_signature', 401)
    const envelope = loadState(await store.readAdmissionState(values.grantId), values.grantId)
    validateMembership(envelope, values, now())
    return { kind: 'agent_capability', keyId: values.keyId, grantId: values.grantId, actionId: values.actionId,
      timestamp: values.timestamp, nonce: values.nonce, idempotencyKey: values.idempotencyKey,
      bodySha256: values.bodySha256, shapeSha256: envelope.shape_sha256, shape: envelope.shape, pending: true }
  }

  async function finalize(principal: AgentCapabilityPrincipal, parsedBody: unknown): Promise<void> {
    const actual = sha256(jcs(parsedBody))
    if (!constantHex(actual, principal.bodySha256)) throw new CapabilityError('body_digest_mismatch', 401)
    const result = await store.finalizeAndConsumeNonce({ grantId: principal.grantId,
      nonceHash: sha256(`${principal.keyId}\0${principal.nonce}`), now: () => now().getTime(),
      validate: (state, nowMs) => {
        const timestamp = parseTime(principal.timestamp)
        if (!timestamp || Math.abs(nowMs - timestamp.getTime()) > REQUEST_SKEW_MS) throw new CapabilityError('timestamp_out_of_range', 401)
        const envelope = loadState(state, principal.grantId)
        validateMembership(envelope, { keyId: principal.keyId, actionId: principal.actionId }, new Date(nowMs))
      },
    })
    if (result === 'replay') throw new CapabilityError('nonce_replay', 401)
    if (result === 'capacity') throw new CapabilityError('nonce_capacity', 403)
    if (result === 'malformed') throw new CapabilityError('grant_invalid', 403)
  }

  return { verifyRequest, finalize }
}

export type CapabilityService = ReturnType<typeof createCapabilityService>

export async function requireAgentCapability(request: FastifyRequest, reply: FastifyReply, actionId: string, parsedBody: unknown, service: CapabilityService): Promise<boolean> {
  const principal = request.agentCapabilityPrincipal
  if (!principal || principal.actionId !== actionId) {
    request.agentCapabilityAudit = { ...(request.agentCapabilityAudit ?? { method: request.method, path: request.url }), outcome: 'denied', reason: 'action_mismatch', statusCode: 403 }
    reply.status(403).send({ error: 'Agent capability access denied.' }); return false
  }
  try {
    await service.finalize(principal, parsedBody)
    request.agentCapabilityAudit = { ...request.agentCapabilityAudit!, outcome: 'accepted', executionDisposition: 'recomputed' }
    return true
  } catch (error) {
    const denied = error instanceof CapabilityError ? error : new CapabilityError('state_unavailable', 503)
    request.agentCapabilityAudit = { ...request.agentCapabilityAudit!, outcome: 'denied', reason: denied.reason, statusCode: denied.status }
    reply.status(denied.status).send({ error: 'Agent capability access denied.' }); return false
  }
}

export async function createOverlay(config: AgentCapabilityConfig, input: z.infer<typeof CreateCapabilityOverlaySchema>, actor: { id: number; email: string }, requestId: string, at = new Date()): Promise<AgentCapabilityEnvelope> {
  if (!config.enabled || !config.attestationPrivateKey || !config.attestationKeyId) throw new Error('Capability overlay creation is not configured.')
  const body = CreateCapabilityOverlaySchema.parse(input)
  if (body.actionIds.some((id) => id !== AGENT_WASTE_CLUSTER_DESCRIPTOR.action_id)) throw new Error('Unknown capability action.')
  if (body.agentKeyIds.some((id) => !config.requestKeys.has(id))) throw new Error('Unknown capability request key.')
  const notBefore = body.notBefore ? parseTime(body.notBefore) : at
  if (!notBefore || notBefore < at || notBefore.getTime() > at.getTime() + MAX_TTL_SECONDS * 1000) throw new Error('notBefore is outside the allowed range.')
  const expiry = new Date(notBefore.getTime() + (body.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000)
  const shape: AgentCapabilityShape = { version: 1, grant_id: uuidV7(at), issued_at: at.toISOString(),
    not_before: notBefore.toISOString(), expires_at: expiry.toISOString(), approved_by: { user_id: actor.id, email: actor.email },
    approval_request_id: requestId, actions: body.actionIds.sort().map((action_id) => ({ action_id,
      spec_sha256: AGENT_WASTE_CLUSTER_SPEC_SHA256, agent_key_ids: [...body.agentKeyIds].sort() })) }
  const shape_sha256 = sha256(jcs(shape))
  const attestation = sign(null, Buffer.from(`helios-agent-capability-overlay-v1\n${shape_sha256}`), config.attestationPrivateKey).toString('base64url')
  const envelope = { shape, shape_sha256, attestation_key_id: config.attestationKeyId, attestation }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > CAPABILITY_ENVELOPE_MAX_BYTES) throw new Error('Capability envelope exceeds 16 KiB.')
  await (config.stateStore ?? productionStateStore).createGrantUnlessEnabledStateAllows(shape.grant_id, envelope)
  return envelope
}

export async function revokeOverlay(config: AgentCapabilityConfig, grantId: string): Promise<void> {
  if (!UUID_V7.test(grantId)) throw new Error('Invalid grant.')
  await (config.stateStore ?? productionStateStore).revokeGrant(grantId)
}

export async function setEmergencyDisabled(config: AgentCapabilityConfig, disabled: boolean): Promise<void> {
  if (!config.enabled) throw new Error('Capability overlays are not configured.')
  await (config.stateStore ?? productionStateStore).setEmergencyDisabled(disabled)
}

export class CapabilityError extends Error {
  constructor(readonly reason: CapabilityDenyReason, readonly status: 401 | 403 | 503) { super(reason) }
}

function validateEnvelope(envelope: AgentCapabilityEnvelope, config: AgentCapabilityConfig): void {
  if (envelope.attestation_key_id !== config.attestationKeyId || sha256(jcs(envelope.shape)) !== envelope.shape_sha256) throw new CapabilityError('grant_invalid', 403)
  const signature = decode(envelope.attestation, 64)
  if (!signature || !verify(null, Buffer.from(`helios-agent-capability-overlay-v1\n${envelope.shape_sha256}`), config.attestationPublicKey!, signature)) throw new CapabilityError('grant_invalid', 403)
  if (!UUID_V7.test(envelope.shape.grant_id)) throw new CapabilityError('grant_invalid', 403)
  const issued = parseTime(envelope.shape.issued_at)
  const notBefore = parseTime(envelope.shape.not_before)
  const expires = parseTime(envelope.shape.expires_at)
  if (!issued || !notBefore || !expires || issued > notBefore || notBefore >= expires ||
      notBefore.getTime() - issued.getTime() > MAX_TTL_SECONDS * 1000 || expires.getTime() - notBefore.getTime() > MAX_TTL_SECONDS * 1000) throw new CapabilityError('grant_invalid', 403)
  const actions = envelope.shape.actions
  if (!sortedUnique(actions.map((row) => row.action_id)) || actions.some((row) => !sortedUnique(row.agent_key_ids) || row.agent_key_ids.some((id) => !config.requestKeys.has(id)))) throw new CapabilityError('grant_invalid', 403)
  for (const row of actions) if (row.action_id !== AGENT_WASTE_CLUSTER_DESCRIPTOR.action_id || row.spec_sha256 !== AGENT_WASTE_CLUSTER_SPEC_SHA256) throw new CapabilityError('grant_invalid', 403)
}

function validateMembership(envelope: AgentCapabilityEnvelope, input: { keyId: string; actionId: string }, at: Date): void {
  const row = envelope.shape.actions.find((candidate) => candidate.action_id === input.actionId)
  if (!row || !row.agent_key_ids.includes(input.keyId)) throw new CapabilityError('grant_invalid', 403)
  if (at < new Date(envelope.shape.not_before) || at >= new Date(envelope.shape.expires_at)) throw new CapabilityError('grant_inactive', 403)
}

function readHeaders(request: FastifyRequest) {
  const result: Record<keyof typeof AGENT_CAPABILITY_HEADERS, string> = { keyId: '', grantId: '', actionId: '', timestamp: '', nonce: '', idempotencyKey: '', bodySha256: '', signature: '' }
  const lowerRaw = request.raw.rawHeaders.filter((_value, index) => index % 2 === 0).map((value) => value.toLowerCase())
  for (const [field, name] of Object.entries(AGENT_CAPABILITY_HEADERS) as Array<[keyof typeof AGENT_CAPABILITY_HEADERS, string]>) {
    if (lowerRaw.filter((candidate) => candidate === name).length > 1) throw new CapabilityError('duplicate_header', 401)
    const value = request.headers[name]
    if (typeof value !== 'string' || value.length === 0) throw new CapabilityError('missing_header', 401)
    result[field] = value
  }
  if (request.headers.cookie || request.headers.authorization) throw new CapabilityError('mixed_credentials', 403)
  if (![result.keyId, result.grantId, result.actionId, result.idempotencyKey].every((value) => TOKEN.test(value)) ||
      !RFC3339.test(result.timestamp) || !HEX.test(result.bodySha256) || !/^[A-Za-z0-9_-]{22,256}$/.test(result.nonce) || !decode(result.nonce)) throw new CapabilityError('invalid_header', 401)
  return result
}

function publicKey(raw: string): KeyObject { const bytes = decode(raw, 32); if (!bytes) throw new Error('Public key must be raw 32-byte base64url.'); return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' }) }
function privateKey(raw: string): KeyObject { const bytes = decode(raw, 32); if (!bytes) throw new Error('Private key must be a raw 32-byte seed.'); return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8' }) }
function decode(raw: string, size?: number): Buffer | null { if (!BASE64URL.test(raw)) return null; const value = Buffer.from(raw, 'base64url'); return (!size || value.length === size) && value.toString('base64url') === raw ? value : null }
function parseTime(raw: string): Date | null { if (!RFC3339.test(raw)) return null; const value = new Date(raw); return Number.isFinite(value.getTime()) && value.toISOString() === raw ? value : null }
function unique(values: string[]): boolean { return new Set(values).size === values.length }
function sortedUnique(values: string[]): boolean { return unique(values) && values.every((value, index) => index === 0 || values[index - 1]! < value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validHost(host: string): boolean { return host.length > 0 && !/[\s/\\]/.test(host) }
function unambiguousPath(path: string): boolean { if (!path.startsWith('/') || /[?#\\\u0000-\u0020\u007f]/.test(path) || /%(?:2f|5c)/i.test(path) || /%(?![0-9a-f]{2})/i.test(path)) return false; try { return new URL(path, 'https://invalid').pathname === path } catch { return false } }
function constantHex(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function uuidV7(at: Date): string { const bytes = randomBytes(16); const ms = BigInt(at.getTime()); for (let index = 5; index >= 0; index--) bytes[index] = Number((ms >> BigInt((5 - index) * 8)) & 0xffn); bytes[6] = (bytes[6]! & 0x0f) | 0x70; bytes[8] = (bytes[8]! & 0x3f) | 0x80; const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` }

const productionStateStore = new PostgresCapabilityStateStore()
