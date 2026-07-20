import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyRequest } from 'fastify'
import { afterEach, expect, it } from 'vitest'

import {
  AGENT_CAPABILITY_HEADERS,
  AGENT_WASTE_CLUSTER_DESCRIPTOR,
  AGENT_WASTE_CLUSTER_SPEC_SHA256,
  buildCapabilityCanonicalPayload,
  createCapabilityService,
  createOverlay,
  jcs,
  parseAgentCapabilityConfig,
  revokeOverlay,
  setEmergencyDisabled,
  sha256,
  type AgentCapabilityEnvelope,
} from './agentCapability.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const ATTESTATION_SEED = Buffer.alloc(32, 1)
const AGENT_SEED = Buffer.alloc(32, 2)
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
function key(seed: Buffer) { return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' }) }
function rawPublic(seed: Buffer): string { return createPublicKey(key(seed)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }

function config(directory: string) {
  return parseAgentCapabilityConfig({
    HELIOS_AGENT_CAPABILITY_OVERLAY_DIR: directory,
    HELIOS_AGENT_CAPABILITY_PUBLIC_KEYS_JSON: JSON.stringify({ 'local-worker-2026q3': rawPublic(AGENT_SEED) }),
    HELIOS_AGENT_CAPABILITY_ATTESTATION_KEY_ID: 'helios-overlay-approval-2026q3',
    HELIOS_AGENT_CAPABILITY_ATTESTATION_PUBLIC_KEY: rawPublic(ATTESTATION_SEED),
    HELIOS_AGENT_CAPABILITY_ATTESTATION_PRIVATE_KEY: ATTESTATION_SEED.toString('base64url'),
  })
}

function createGrant(directory: string, at: Date) {
  const parsed = config(directory)
  const envelope = createOverlay(
    parsed,
    { actionIds: ['agent-waste.cluster.v1'], agentKeyIds: ['local-worker-2026q3'] },
    { id: 123, email: 'operator@example.com' },
    'req-signed',
    at,
  )
  return { parsed, envelope }
}

function signedRequest(
  envelope: AgentCapabilityEnvelope,
  at: Date,
  overrides: Partial<{
    method: string
    path: string
    url: string
    host: string
    contentType: string
    bodySha256: string
    nonce: string
    timestamp: string
    signature: string
  }> = {},
): FastifyRequest {
  const method = overrides.method ?? 'POST'
  const path = overrides.path ?? '/api/agent-waste/clusters'
  const url = overrides.url ?? path
  const host = overrides.host ?? 'helios.freshlybaked.us'
  const contentType = overrides.contentType ?? 'application/json'
  const bodySha256 = overrides.bodySha256 ?? sha256('{}')
  const timestamp = overrides.timestamp ?? at.toISOString()
  const nonce = overrides.nonce ?? 'AAAAAAAAAAAAAAAAAAAAAA'
  const payload = buildCapabilityCanonicalPayload({
    method,
    host,
    path,
    query: '',
    contentType,
    bodySha256,
    keyId: 'local-worker-2026q3',
    grantId: envelope.shape.grant_id,
    actionId: 'agent-waste.cluster.v1',
    timestamp,
    nonce,
    idempotencyKey: 'cluster-test-1',
  })
  const headers: Record<string, string> = {
    host,
    'content-type': contentType,
    [AGENT_CAPABILITY_HEADERS.keyId]: 'local-worker-2026q3',
    [AGENT_CAPABILITY_HEADERS.grantId]: envelope.shape.grant_id,
    [AGENT_CAPABILITY_HEADERS.actionId]: 'agent-waste.cluster.v1',
    [AGENT_CAPABILITY_HEADERS.timestamp]: timestamp,
    [AGENT_CAPABILITY_HEADERS.nonce]: nonce,
    [AGENT_CAPABILITY_HEADERS.idempotencyKey]: 'cluster-test-1',
    [AGENT_CAPABILITY_HEADERS.bodySha256]: bodySha256,
    [AGENT_CAPABILITY_HEADERS.signature]: overrides.signature
      ?? sign(null, Buffer.from(payload), key(AGENT_SEED)).toString('base64url'),
  }
  return {
    headers,
    method,
    url,
    raw: { rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]) },
  } as unknown as FastifyRequest
}

it('pins the registry, semantic body, shape and request golden vectors', () => {
  expect(jcs(AGENT_WASTE_CLUSTER_DESCRIPTOR)).toBe('{"action_id":"agent-waste.cluster.v1","body_limit_bytes":4096,"body_schema":"strict-empty-object-v1","content_type":"application/json","method":"POST","path":"/api/agent-waste/clusters","query_policy":"none","retry_class":"analysis-idempotent-v1"}')
  expect(sha256(jcs(AGENT_WASTE_CLUSTER_DESCRIPTOR))).toBe(AGENT_WASTE_CLUSTER_SPEC_SHA256)
  expect(sha256('{}')).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  const shape = {
    version: 1, grant_id: '019f7f00-0000-7000-8000-000000000001', issued_at: '2026-07-20T12:00:00.000Z',
    not_before: '2026-07-20T12:00:00.000Z', expires_at: '2026-07-20T16:00:00.000Z',
    approved_by: { user_id: 123, email: 'operator@example.com' }, approval_request_id: 'req-golden-1',
    actions: [{ action_id: 'agent-waste.cluster.v1', spec_sha256: AGENT_WASTE_CLUSTER_SPEC_SHA256, agent_key_ids: ['local-worker-2026q3'] }],
  }
  const digest = sha256(jcs(shape))
  expect(digest).toBe('2bce8142979ae6db9a817f9931908b272780aa13c3ed64f680b85ae14b2055a2')
  expect(sign(null, Buffer.from(`helios-agent-capability-overlay-v1\n${digest}`), key(ATTESTATION_SEED)).toString('base64url'))
    .toBe('UY962bfTr3dsLKQViY-y41fleaXgsir4qXdAYg-HcBD21UzNrt1j4KZ5YPojs_5-Jmi3x3FIxbOFvTqfehMFCQ')
  const payload = buildCapabilityCanonicalPayload({ method: 'POST', host: 'helios.freshlybaked.us', path: '/api/agent-waste/clusters', query: '', contentType: 'application/json', bodySha256: sha256('{}'), keyId: 'local-worker-2026q3', grantId: shape.grant_id, actionId: 'agent-waste.cluster.v1', timestamp: '2026-07-20T12:01:00.000Z', nonce: 'AAAAAAAAAAAAAAAAAAAAAA', idempotencyKey: 'cluster-golden-1' })
  expect(sign(null, Buffer.from(payload), key(AGENT_SEED)).toString('base64url')).toBe('4dfRK1tRkR4yX8qXSW934N20UqkU9QLyDkVo_mGx69JfWKlSh2z_EGbMYYa3Y0ChpKo2GRGBdydYxlQicAuhDQ')
})

it('writes immutable grants with default four-hour TTL and reloads revocation across verifier instances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const parsed = config(directory)
  const now = new Date('2026-07-20T12:00:00.000Z')
  const envelope = createOverlay(parsed, { actionIds: ['agent-waste.cluster.v1'], agentKeyIds: ['local-worker-2026q3'] }, { id: 123, email: 'operator@example.com' }, 'req-1', now)
  expect(envelope.shape.expires_at).toBe('2026-07-20T16:00:00.000Z')
  expect(JSON.parse(readFileSync(join(directory, `${envelope.shape.grant_id}.json`), 'utf8'))).toEqual(envelope)
  const first = createCapabilityService(parsed, () => now)
  const second = createCapabilityService(parsed, () => now)
  expect(first.load(envelope.shape.grant_id)).toEqual(envelope)
  expect(second.load(envelope.shape.grant_id)).toEqual(envelope)
  revokeOverlay(parsed, envelope.shape.grant_id)
  expect(() => first.load(envelope.shape.grant_id)).toThrow('grant_revoked')
  expect(() => second.load(envelope.shape.grant_id)).toThrow('grant_revoked')
})

it('fails closed for absent or invalid config and emergency state is shared immediately', () => {
  expect(parseAgentCapabilityConfig({}).enabled).toBe(false)
  expect(parseAgentCapabilityConfig({ HELIOS_AGENT_CAPABILITY_OVERLAY_DIR: '/tmp/x' }).enabled).toBe(false)
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const parsed = config(directory)
  const now = new Date('2026-07-20T12:00:00.000Z')
  const envelope = createOverlay(parsed, { actionIds: ['agent-waste.cluster.v1'], agentKeyIds: ['local-worker-2026q3'] }, { id: 123, email: 'operator@example.com' }, 'req-2', now)
  const services = [createCapabilityService(parsed, () => now), createCapabilityService(parsed, () => now)]
  setEmergencyDisabled(parsed, true)
  for (const service of services) expect(() => service.load(envelope.shape.grant_id)).toThrow('emergency_disabled')
  setEmergencyDisabled(parsed, false)
  for (const service of services) expect(service.load(envelope.shape.grant_id)).toEqual(envelope)
})

it('keeps request and attestation keys cryptographically separate', () => {
  const input = Buffer.from('separate scopes')
  const signature = sign(null, input, key(AGENT_SEED))
  expect(verify(null, input, createPublicKey(key(AGENT_SEED)), signature)).toBe(true)
  expect(verify(null, input, createPublicKey(key(ATTESTATION_SEED)), signature)).toBe(false)
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const parsed = parseAgentCapabilityConfig({
    HELIOS_AGENT_CAPABILITY_OVERLAY_DIR: directory,
    HELIOS_AGENT_CAPABILITY_PUBLIC_KEYS_JSON: JSON.stringify({ request: rawPublic(ATTESTATION_SEED) }),
    HELIOS_AGENT_CAPABILITY_ATTESTATION_KEY_ID: 'attestation',
    HELIOS_AGENT_CAPABILITY_ATTESTATION_PUBLIC_KEY: rawPublic(ATTESTATION_SEED),
  })
  expect(parsed.enabled).toBe(false)
  expect(parsed.configurationIssue).toContain('must not equal')
})

it.each([
  ['non-canonical time', (value: AgentCapabilityEnvelope) => { value.shape.issued_at = '2026-02-30T12:00:00.000Z' }],
  ['issued after activation', (value: AgentCapabilityEnvelope) => { value.shape.issued_at = '2026-07-20T12:00:01.000Z' }],
  ['zero TTL', (value: AgentCapabilityEnvelope) => { value.shape.expires_at = value.shape.not_before }],
  ['activation delay over 14 days', (value: AgentCapabilityEnvelope) => { value.shape.not_before = '2026-08-04T12:00:00.001Z'; value.shape.expires_at = '2026-08-04T13:00:00.001Z' }],
  ['TTL over 14 days', (value: AgentCapabilityEnvelope) => { value.shape.expires_at = '2026-08-03T12:00:00.001Z' }],
  ['non-v7 grant id', (value: AgentCapabilityEnvelope) => { value.shape.grant_id = '019f7f00-0000-4000-8000-000000000001' }],
  ['unknown request key', (value: AgentCapabilityEnvelope) => { value.shape.actions[0]!.agent_key_ids = ['retired-worker'] }],
  ['unsorted request keys', (value: AgentCapabilityEnvelope) => { value.shape.actions[0]!.agent_key_ids = ['z-worker', 'local-worker-2026q3'] }],
] as const)('rejects a correctly re-attested envelope with %s', (_name, mutate) => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const parsed = config(directory)
  const at = new Date('2026-07-20T12:00:00.000Z')
  const envelope = createOverlay(parsed, { actionIds: ['agent-waste.cluster.v1'], agentKeyIds: ['local-worker-2026q3'] }, { id: 1, email: 'operator@example.com' }, 'req-malformed', at)
  mutate(envelope)
  envelope.shape_sha256 = sha256(jcs(envelope.shape))
  envelope.attestation = sign(null, Buffer.from(`helios-agent-capability-overlay-v1\n${envelope.shape_sha256}`), key(ATTESTATION_SEED)).toString('base64url')
  writeFileSync(join(directory, `${envelope.shape.grant_id}.json`), JSON.stringify(envelope))
  expect(() => createCapabilityService(parsed, () => at).load(envelope.shape.grant_id)).toThrow('grant_invalid')
})

it('revokes malformed artifacts while emergency-disabled without loading admission state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const parsed = config(directory)
  const grantId = '019f7f00-0000-7000-8000-000000000001'
  writeFileSync(join(directory, `${grantId}.json`), '{malformed')
  setEmergencyDisabled(parsed, true)
  revokeOverlay(parsed, grantId)
  expect(existsSync(join(directory, `${grantId}.json`))).toBe(false)
})

it('verifies the exact signed request and consumes its nonce only after body binding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const at = new Date('2026-07-20T12:01:00.000Z')
  const { parsed, envelope } = createGrant(directory, new Date('2026-07-20T12:00:00.000Z'))
  const service = createCapabilityService(parsed, () => at)
  const request = signedRequest(envelope, at)
  const principal = service.verifyRequest(request, '/api/agent-waste/clusters')

  expect(principal.kind).toBe('agent_capability')
  expect(() => service.finalize(principal, { unexpected: true })).toThrow('body_digest_mismatch')
  expect(() => service.finalize(principal, {})).not.toThrow()
  expect(() => service.finalize(principal, {})).toThrow('nonce_replay')
})

it.each([
  ['query', { url: '/api/agent-waste/clusters?' }],
  ['method', { method: 'GET' }],
  ['path', { path: '/api/agent-waste/promote' }],
  ['content type', { contentType: 'application/json; charset=utf-8' }],
  ['host', { host: 'helios.freshlybaked.us/path' }],
  ['timestamp', { timestamp: '2026-07-20T12:01:00Z' }],
  ['signature', { signature: 'A'.repeat(86) }],
] as const)('rejects a signed request with mismatched %s', (_name, override) => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const at = new Date('2026-07-20T12:01:00.000Z')
  const { parsed, envelope } = createGrant(directory, new Date('2026-07-20T12:00:00.000Z'))
  const request = signedRequest(envelope, at, override)
  expect(() => createCapabilityService(parsed, () => at).verifyRequest(request, override.path ?? '/api/agent-waste/clusters')).toThrow()
})

it('fails closed instead of evicting a live nonce when the cache is full', () => {
  const directory = mkdtempSync(join(tmpdir(), 'helios-capability-')); directories.push(directory)
  const at = new Date('2026-07-20T12:01:00.000Z')
  const parsed = parseAgentCapabilityConfig({
    HELIOS_AGENT_CAPABILITY_OVERLAY_DIR: directory,
    HELIOS_AGENT_CAPABILITY_PUBLIC_KEYS_JSON: JSON.stringify({ 'local-worker-2026q3': rawPublic(AGENT_SEED) }),
    HELIOS_AGENT_CAPABILITY_ATTESTATION_KEY_ID: 'helios-overlay-approval-2026q3',
    HELIOS_AGENT_CAPABILITY_ATTESTATION_PUBLIC_KEY: rawPublic(ATTESTATION_SEED),
    HELIOS_AGENT_CAPABILITY_ATTESTATION_PRIVATE_KEY: ATTESTATION_SEED.toString('base64url'),
    HELIOS_AGENT_CAPABILITY_NONCE_CACHE_SIZE: '1',
  })
  const envelope = createOverlay(parsed, { actionIds: ['agent-waste.cluster.v1'], agentKeyIds: ['local-worker-2026q3'] }, { id: 123, email: 'operator@example.com' }, 'req-capacity', new Date('2026-07-20T12:00:00.000Z'))
  const service = createCapabilityService(parsed, () => at)
  const first = service.verifyRequest(signedRequest(envelope, at), '/api/agent-waste/clusters')
  service.finalize(first, {})
  const second = service.verifyRequest(
    signedRequest(envelope, at, { nonce: Buffer.alloc(16, 1).toString('base64url') }),
    '/api/agent-waste/clusters',
  )
  expect(() => service.finalize(second, {})).toThrow('nonce_capacity')
})
