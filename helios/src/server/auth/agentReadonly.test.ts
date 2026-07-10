import { generateKeyPairSync, sign } from 'node:crypto'

import { expect, it } from 'vitest'

import {
  AGENT_READONLY_HEADER_NAMES,
  buildAgentReadonlyCanonicalPayload,
  createAgentReadonlyVerifier,
  parseAgentReadonlyConfigFromEnv,
  type AgentReadonlyConfig,
  type AgentReadonlyRequestLike,
} from './agentReadonly.js'

const NOW = new Date('2026-07-10T05:30:00Z')
const KEY_ID = 'amp-local-vps3-2026q3'
const RULE_ID = 'agent-waste-review-2026-07-10'
const NONCE = 'abc1234567890XYZ_nonce'

function makeKeyPair() {
  const keyPair = generateKeyPairSync('ed25519')
  const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey: keyPair.privateKey,
    publicKeyBase64Url: publicKeyDer.subarray(-32).toString('base64url'),
  }
}

function makeConfig(publicKeyBase64Url: string, overrides: Partial<Extract<AgentReadonlyConfig, { enabled: true }>> = {}): AgentReadonlyConfig {
  return {
    enabled: true,
    publicKeys: [{ id: KEY_ID, publicKey: publicKeyBase64Url }],
    allowlistRules: [
      {
        id: RULE_ID,
        owner: 'virusdave/top-level#62 rollout',
        reason: 'Verify signed-agent readonly access.',
        notBefore: new Date('2026-07-10T00:00:00Z'),
        notAfter: new Date('2026-07-17T00:00:00Z'),
        maxResponseBytes: 1024,
        paths: [
          {
            method: 'GET',
            kind: 'api',
            match: 'exact',
            path: '/api/agent-waste/backlog',
            safeReadNote: 'Read-only backlog endpoint; no promote/write path.',
          },
          {
            method: 'GET',
            kind: 'asset',
            match: 'prefix',
            path: '/assets/',
            safeReadNote: 'Hashed static assets only.',
          },
        ],
      },
    ],
    timestampSkewMs: 90_000,
    nonceTtlMs: 180_000,
    nonceCacheSize: 100,
    defaultMaxResponseBytes: 1024,
    maxResponseBytes: 2048,
    ...overrides,
  }
}

function signedRequest(input: {
  privateKey: ReturnType<typeof makeKeyPair> extends { privateKey: infer T } ? T : never
  method?: string
  host?: string
  pathAndQuery?: string
  keyId?: string
  ruleId?: string
  timestamp?: string
  nonce?: string
  tamperPayload?: (payload: string) => string
  headers?: Record<string, string | string[] | undefined>
}): AgentReadonlyRequestLike {
  const method = input.method ?? 'GET'
  const host = input.host ?? 'helios.freshlybaked.us'
  const pathAndQuery = input.pathAndQuery ?? '/api/agent-waste/backlog?tab=pending'
  const keyId = input.keyId ?? KEY_ID
  const ruleId = input.ruleId ?? RULE_ID
  const timestamp = input.timestamp ?? NOW.toISOString()
  const nonce = input.nonce ?? NONCE
  const payload = buildAgentReadonlyCanonicalPayload({
    method: method as 'GET' | 'HEAD',
    host,
    pathAndQuery,
    keyId,
    ruleId,
    timestamp,
    nonce,
  })
  const signature = sign(null, Buffer.from(input.tamperPayload?.(payload) ?? payload, 'utf8'), input.privateKey).toString('base64url')
  return {
    method,
    host,
    pathAndQuery,
    headers: {
      [AGENT_READONLY_HEADER_NAMES.keyId]: keyId,
      [AGENT_READONLY_HEADER_NAMES.ruleId]: ruleId,
      [AGENT_READONLY_HEADER_NAMES.timestamp]: timestamp,
      [AGENT_READONLY_HEADER_NAMES.nonce]: nonce,
      [AGENT_READONLY_HEADER_NAMES.signature]: signature,
      ...input.headers,
    },
  }
}

it('builds the signed-agent v1 canonical payload bytes exactly', () => {
  expect(
    buildAgentReadonlyCanonicalPayload({
      method: 'GET',
      host: 'helios.freshlybaked.us',
      pathAndQuery: '/config/agent-waste?tab=pending',
      keyId: KEY_ID,
      ruleId: RULE_ID,
      timestamp: '2026-07-10T05:30:00Z',
      nonce: '<128-bit random base64url>',
    }),
  ).toBe([
    'helios-agent-readonly-v1',
    'method:GET',
    'host:helios.freshlybaked.us',
    'path:/config/agent-waste?tab=pending',
    `key_id:${KEY_ID}`,
    `rule_id:${RULE_ID}`,
    'timestamp:2026-07-10T05:30:00Z',
    'nonce:<128-bit random base64url>',
  ].join('\n'))
})

it('accepts a fresh signed GET request for an active allowlist path', () => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const result = verifier.verify(signedRequest({ privateKey: keys.privateKey }), NOW)

  expect(result).toMatchObject({
    ok: true,
    keyId: KEY_ID,
    ruleId: RULE_ID,
    method: 'GET',
    pathAndQuery: '/api/agent-waste/backlog?tab=pending',
    maxResponseBytes: 1024,
  })
})

it('accepts HEAD against a GET allowlist entry without reading a response body', () => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const result = verifier.verify(
    signedRequest({ privateKey: keys.privateKey, method: 'HEAD', nonce: 'abc1234567890XYZ_head' }),
    NOW,
  )

  expect(result).toMatchObject({ ok: true, method: 'HEAD' })
})

it.each([
  ['unsigned request', () => ({ headers: {}, expected: 'not_signed_agent_request' })],
  ['missing header', () => ({ headers: { [AGENT_READONLY_HEADER_NAMES.signature]: undefined }, expected: 'missing_header' })],
  ['duplicate header', () => ({ headers: { [AGENT_READONLY_HEADER_NAMES.nonce]: ['one', 'two'] }, expected: 'duplicate_header' })],
  ['bad base64 signature', () => ({ headers: { [AGENT_READONLY_HEADER_NAMES.signature]: 'not*base64' }, expected: 'invalid_header' })],
  ['cookie mixed with signature', () => ({ headers: { cookie: 'helios-session=signed' }, expected: 'mixed_credentials' })],
  ['authorization mixed with signature', () => ({ headers: { authorization: 'Bearer token' }, expected: 'mixed_credentials' })],
] as const)('denies %s', (_name, buildCase) => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const testCase = buildCase()
  const request = testCase.expected === 'not_signed_agent_request'
    ? { method: 'GET', host: 'helios.freshlybaked.us', pathAndQuery: '/api/agent-waste/backlog', headers: testCase.headers }
    : signedRequest({ privateKey: keys.privateKey, headers: testCase.headers })

  expect(verifier.verify(request, NOW)).toMatchObject({ ok: false, reason: testCase.expected })
})

it.each([
  ['POST', '/api/agent-waste/backlog', 'method_not_allowed'],
  ['GET', '/api/not-allowlisted', 'path_not_allowed'],
  ['GET', '/assetsx/index.js', 'path_not_allowed'],
  ['GET', '/assets/index.js', null],
  ['GET', '/safe/%2fsecret', 'ambiguous_path'],
  ['GET', '/safe/../secret', 'ambiguous_path'],
  ['GET', '/safe/%ZZ', 'ambiguous_path'],
] as const)('checks method/path rule %s %s', (method, pathAndQuery, expectedReason) => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const result = verifier.verify(
    signedRequest({ privateKey: keys.privateKey, method, pathAndQuery, nonce: `nonce-${method}-${pathAndQuery}`.replace(/[^A-Za-z0-9_-]/g, '_') }),
    NOW,
  )

  if (expectedReason === null) {
    expect(result).toMatchObject({ ok: true })
  } else {
    expect(result).toMatchObject({ ok: false, reason: expectedReason })
  }
})

it.each([
  ['unknown key', { keyId: 'unknown-key' }, 'unknown_key'],
  ['unknown rule', { ruleId: 'unknown-rule' }, 'unknown_rule'],
  ['invalid signature', { tamperPayload: (payload: string) => `${payload}\nextra` }, 'invalid_signature'],
  ['stale timestamp', { timestamp: '2026-07-10T05:20:00Z' }, 'timestamp_out_of_range'],
  ['future timestamp', { timestamp: '2026-07-10T05:40:00Z' }, 'timestamp_out_of_range'],
] as const)('denies %s', (_name, requestOverrides, expectedReason) => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const result = verifier.verify(signedRequest({ privateKey: keys.privateKey, ...requestOverrides }), NOW)

  expect(result).toMatchObject({ ok: false, reason: expectedReason })
})

it('rejects nonce replay only after a valid signed request consumes the nonce', () => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(makeConfig(keys.publicKeyBase64Url))
  const request = signedRequest({ privateKey: keys.privateKey })

  expect(verifier.verify(request, NOW)).toMatchObject({ ok: true })
  expect(verifier.verify(request, NOW)).toMatchObject({ ok: false, reason: 'nonce_replay' })
})

it('denies an inactive allowlist rule', () => {
  const keys = makeKeyPair()
  const verifier = createAgentReadonlyVerifier(
    makeConfig(keys.publicKeyBase64Url, {
      allowlistRules: [
        {
          ...makeConfig(keys.publicKeyBase64Url).allowlistRules[0],
          notBefore: new Date('2026-07-11T00:00:00Z'),
        },
      ],
    }),
  )

  expect(verifier.verify(signedRequest({ privateKey: keys.privateKey }), NOW)).toMatchObject({
    ok: false,
    reason: 'inactive_rule',
  })
})

it('parses env config and defaults to fail-closed when config is absent or invalid', () => {
  const keys = makeKeyPair()
  const allowlist = {
    id: RULE_ID,
    owner: 'operator',
    reason: 'test',
    not_before: '2026-07-10T00:00:00Z',
    not_after: '2026-07-17T00:00:00Z',
    max_response_bytes: 512,
    paths: [
      {
        method: 'GET',
        kind: 'session',
        match: 'exact',
        path: '/api/session',
        safe_read_note: 'Synthetic session envelope only.',
      },
    ],
  }

  expect(parseAgentReadonlyConfigFromEnv({}).enabled).toBe(false)
  const parsed = parseAgentReadonlyConfigFromEnv({
    HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON: JSON.stringify([{ id: KEY_ID, public_key: keys.publicKeyBase64Url }]),
    HELIOS_AGENT_READONLY_ALLOWLIST_JSON: JSON.stringify(allowlist),
    HELIOS_AGENT_READONLY_TIMESTAMP_SKEW_SECONDS: '120',
  })
  expect(parsed).toMatchObject({ enabled: true, timestampSkewMs: 120_000 })
  if (parsed.enabled) {
    expect(parsed.allowlistRules[0].paths[0]).toMatchObject({ path: '/api/session', kind: 'session' })
  }
  expect(
    parseAgentReadonlyConfigFromEnv({
      HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON: '{',
      HELIOS_AGENT_READONLY_ALLOWLIST_JSON: JSON.stringify(allowlist),
    }),
  ).toMatchObject({ enabled: false })
})

it('fails closed for broad or invalid allowlist shapes', () => {
  const keys = makeKeyPair()
  const baseRule = {
    id: RULE_ID,
    owner: 'operator',
    reason: 'test',
    not_before: '2026-07-10T00:00:00Z',
    not_after: '2026-07-17T00:00:00Z',
    paths: [
      {
        method: 'GET',
        kind: 'api',
        match: 'prefix',
        path: '/api/',
        safe_read_note: 'Too broad.',
      },
    ],
  }
  const parsed = parseAgentReadonlyConfigFromEnv({
    HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON: JSON.stringify({ [KEY_ID]: keys.publicKeyBase64Url }),
    HELIOS_AGENT_READONLY_ALLOWLIST_JSON: JSON.stringify(baseRule),
  })

  expect(parsed).toMatchObject({ enabled: false })
  expect(parsed.configurationIssue).toMatch(/must be limited to asset routes/)
})
