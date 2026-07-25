import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MssUploadError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message)
    }
  }
  return {
    allow: true,
    find: vi.fn(),
    MssUploadError,
    query: vi.fn(),
    upload: vi.fn(),
  }
})

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn(async (_request: unknown, reply: { status: (code: number) => { send: (body: unknown) => void } }) => {
    if (!mocks.allow) {
      reply.status(403).send({ error: 'denied' })
      return null
    }
    return { id: 7, email: 'operator@example.com', name: 'Operator', role: 'admin' }
  }),
}))

vi.mock('../ads/mssOneOffsUpload.js', () => ({
  findMssSlotsByNotePrefix: mocks.find,
  MssUploadError: mocks.MssUploadError,
  uploadStaticBundleToMssOneOffs: mocks.upload,
}))

vi.mock('../db/pool.js', () => ({
  getPool: () => ({ connect: async () => ({ query: mocks.query, release: vi.fn() }) }),
}))

import { registerOperatorCaptureRoutes, resetOperatorCaptureStateForTests } from './operatorCaptures.js'

beforeEach(() => {
  mocks.allow = true
  mocks.find.mockReset().mockResolvedValue([])
  mocks.query.mockReset().mockResolvedValue({ rows: [] })
  mocks.upload.mockReset().mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    nonce: 'nonce',
    publicUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/',
  })
  resetOperatorCaptureStateForTests()
})

afterEach(() => vi.clearAllMocks())

describe('POST /api/operator-captures', () => {
  it('admin-gates and validates the multipart upload', async () => {
    const server = await makeServer()
    try {
      mocks.allow = false
      const denied = await server.inject({ method: 'POST', url: '/api/operator-captures' })
      expect(denied.statusCode).toBe(403)

      mocks.allow = true
      const malformed = await injectCapture(server, { redirectUrl: 'https://evil.example/issues/1' })
      expect(malformed.statusCode).toBe(400)
      expect(mocks.upload).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('publishes a bounded PNG bundle and reuses an idempotent success', async () => {
    const server = await makeServer()
    let captureBytes: Buffer | undefined
    mocks.upload.mockImplementation(async ({ files }: { files: Array<{ sourcePath?: string }> }) => {
      captureBytes = await readFile(files[0]!.sourcePath!)
      return {
        expiresAt: new Date(Date.now() + 60_000),
        nonce: 'nonce',
        publicUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/',
      }
    })
    try {
      const first = await injectCapture(server)
      expect(first.statusCode).toBe(201)
      expect(first.json()).toMatchObject({
        captureId: 'capture_key_123456789',
        directUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/capture.png',
        redirectUrl: 'https://github.com/FreshlyBakedNYC/automation/issues/89#issuecomment-123',
        reviewUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/',
      })
      expect(mocks.upload).toHaveBeenCalledTimes(1)
      const request = mocks.upload.mock.calls[0]?.[0]
      expect(request.files.map((file: { path: string }) => file.path)).toEqual(['capture.png', 'index.html', 'metadata.json'])
      expect(request.files[0]).not.toHaveProperty('bytes')
      expect(captureBytes).toEqual(testPng(100, 50))
      await vi.waitFor(async () => expect(access(request.files[0].sourcePath)).rejects.toThrow())
      expect(request.ttlSeconds).toBe(86_400)
      const note = request.note as string
      const expectedIdentity = createHash('sha256')
        .update(testPng(100, 50))
        .update(request.files[2].bytes)
        .digest('hex')
      expect(note).toBe(`helios-capture-v1:capture_key_123456789:7:${expectedIdentity}`)

      const retry = await injectCapture(server)
      expect(retry.statusCode).toBe(200)
      expect(retry.json()).toEqual(first.json())
      expect(mocks.upload).toHaveBeenCalledTimes(1)

      resetOperatorCaptureStateForTests()
      mocks.find.mockResolvedValue([{
        expiresAt: new Date(first.json().expiresAt),
        nonce: 'nonce',
        note,
        publicUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/',
      }])
      const otherMirrorRetry = await injectCapture(server)
      expect(otherMirrorRetry.statusCode).toBe(201)
      expect(otherMirrorRetry.json()).toEqual(first.json())
      expect(mocks.upload).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('rejects PNG dimensions that do not match capture metadata', async () => {
    const server = await makeServer()
    try {
      const response = await injectCapture(server, { width: 110 })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('dimension')
      expect(mocks.upload).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('rejects a truncated PNG that ends before the complete IHDR chunk', async () => {
    const server = await makeServer()
    try {
      const response = await injectCapture(server, { png: testPng(100, 50).subarray(0, 24) })
      expect(response.statusCode).toBe(400)
      expect(mocks.upload).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('accepts tall mobile captures beyond the old 12,000-pixel limit', async () => {
    const server = await makeServer()
    try {
      const response = await injectCapture(server, { height: 20_000 })
      expect(response.statusCode).toBe(201)
      expect(mocks.upload).toHaveBeenCalledOnce()
    } finally {
      await server.close()
    }
  })

  it('returns an actionable 413 for the MSS slot byte limit', async () => {
    const server = await makeServer()
    mocks.upload.mockRejectedValueOnce(new mocks.MssUploadError('declared byte limit exceeded', 'slot_byte_limit'))
    try {
      const response = await injectCapture(server)
      expect(response.statusCode).toBe(413)
      expect(response.json().error).toContain('smaller-capture')
    } finally {
      await server.close()
    }
  })

  it('rejects concurrent capture buffering instead of queueing large bodies', async () => {
    const server = await makeServer()
    let finishUpload: (() => void) | undefined
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => {
      finishUpload = () => resolve({
        expiresAt: new Date(Date.now() + 60_000),
        nonce: 'nonce',
        publicUrl: 'https://vpn-helios.freshlybaked.us/one-offs/nonce/',
      })
    }))
    try {
      const first = injectCapture(server)
      await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce())
      const concurrent = await injectCapture(server)
      expect(concurrent.statusCode).toBe(503)
      expect(concurrent.json().error).toContain('Another capture')
      finishUpload?.()
      expect((await first).statusCode).toBe(201)
    } finally {
      finishUpload?.()
      await server.close()
    }
  })
})

async function makeServer() {
  const server = Fastify()
  await server.register(multipart, { limits: { fields: 20, fileSize: 12 * 1024 * 1024, files: 1 } })
  await registerOperatorCaptureRoutes(server)
  await server.ready()
  return server
}

async function injectCapture(server: Awaited<ReturnType<typeof makeServer>>, overrides: { height?: number; png?: Buffer; redirectUrl?: string; width?: number } = {}) {
  const boundary = 'capture-test-boundary'
  const fields = {
    captureKey: 'capture_key_123456789',
    captureName: 'task-overview',
    redirectUrl: overrides.redirectUrl ?? 'https://github.com/FreshlyBakedNYC/automation/issues/89#issuecomment-123',
    metadata: JSON.stringify({
      capturedAt: '2026-07-24T12:00:00.000Z',
      devicePixelRatio: 1,
      height: overrides.height ?? 50,
      pageUrl: 'https://vpn-helios.freshlybaked.us/tasks',
      renderer: 'html-to-image@1.11.13',
      viewportHeight: 800,
      viewportWidth: 1200,
      width: overrides.width ?? 100,
    }),
  }
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="capture"; filename="capture.png"\r\nContent-Type: image/png\r\n\r\n`))
  chunks.push(overrides.png ?? testPng(100, overrides.height ?? 50))
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return server.inject({
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    method: 'POST',
    payload: Buffer.concat(chunks),
    url: '/api/operator-captures',
  })
}

function testPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
