import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findMssSlotsByNotePrefix, uploadStaticBundleToMssOneOffs } from './mssOneOffsUpload.js'

const tempDirs: string[] = []
const originalSocket = process.env.MSS_ONE_OFFS_CONTROL_SOCKET
const NONCE = 'nonce_123456789012345678901234'

afterEach(async () => {
  if (originalSocket === undefined) delete process.env.MSS_ONE_OFFS_CONTROL_SOCKET
  else process.env.MSS_ONE_OFFS_CONTROL_SOCKET = originalSocket
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('uploadStaticBundleToMssOneOffs', () => {
  it('declares exact bytes, streams every file, then activates the slot', async () => {
    const requests: Array<{ body: Buffer; method: string; path: string }> = []
    const fixture = await startSocketServer((request) => {
      requests.push(request)
      if (request.path === '/v1/uploads') return response(201, uploadStatus(0, 0, false))
      if (request.path.endsWith('/capture.png')) return response(200, uploadStatus(1, 3, false))
      if (request.path.endsWith('/index.html')) return response(200, uploadStatus(2, 5, true))
      if (request.path === '/v1/slots') return response(201, {
        expiresAtMs: Date.now() + 60_000,
        nonce: NONCE,
        note: 'capture',
        uploadId: 'upload-1',
        url: `https://vpn-helios.freshlybaked.us/one-offs/${NONCE}/`,
      })
      return response(404, { error: 'unexpected' })
    })
    try {
      const result = await uploadStaticBundleToMssOneOffs({
        files: [
          { path: 'capture.png', bytes: Buffer.from('png'), contentType: 'image/png' },
          { path: 'index.html', bytes: Buffer.from('ok'), contentType: 'text/html' },
        ],
        note: 'capture',
        ttlSeconds: 60,
      })
      expect(result.publicUrl).toBe(`https://vpn-helios.freshlybaked.us/one-offs/${NONCE}/`)
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'POST /v1/uploads',
        'PUT /v1/uploads/upload-1/capture.png',
        'PUT /v1/uploads/upload-1/index.html',
        'POST /v1/slots',
      ])
      expect(JSON.parse(requests[0]!.body.toString())).toEqual({ bytes: 5, files: 2 })
      expect(JSON.parse(requests[3]!.body.toString())).toMatchObject({ uploadId: 'upload-1', ttlSeconds: 60 })
    } finally {
      await fixture.close()
    }
  })

  it('deletes a reserved upload when streaming fails', async () => {
    const requests: string[] = []
    const fixture = await startSocketServer((request) => {
      requests.push(`${request.method} ${request.path}`)
      if (request.path === '/v1/uploads' && request.method === 'POST') return response(201, uploadStatus(0, 0, false))
      if (request.method === 'PUT') return response(500, { error: 'disk failed' })
      if (request.method === 'DELETE') return response(200, { deleted: true, id: 'upload-1' })
      return response(404, { error: 'unexpected' })
    })
    try {
      await expect(uploadStaticBundleToMssOneOffs({
        files: [{ path: 'capture.png', bytes: Buffer.from('png'), contentType: 'image/png' }],
        note: 'capture',
        ttlSeconds: 60,
      })).rejects.toThrow('disk failed')
      expect(requests).toEqual([
        'POST /v1/uploads',
        'PUT /v1/uploads/upload-1/capture.png',
        'DELETE /v1/uploads/upload-1',
      ])
    } finally {
      await fixture.close()
    }
  })

  it('lists matching live slots and rejects a foreign publication origin', async () => {
    let foreign = false
    const fixture = await startSocketServer((request) => {
      if (request.path !== '/v1/slots') return response(404, { error: 'unexpected' })
      const slot = {
        expiresAtMs: Date.now() + 60_000,
        nonce: NONCE,
        note: 'capture:key:hash',
        uploadId: 'upload-1',
        url: foreign
          ? `https://foreign.example/one-offs/${NONCE}/`
          : `https://vpn-helios.freshlybaked.us/one-offs/${NONCE}/`,
      }
      const noise = Array.from({ length: 499 }, (_, index) => {
        const nonce = `noise_${String(index).padStart(24, '0')}`
        return {
          expiresAtMs: Date.now() + 60_000,
          nonce,
          note: `unrelated:${'x'.repeat(900)}`,
          uploadId: `upload-${index}`,
          url: `https://vpn-helios.freshlybaked.us/one-offs/${nonce}/`,
        }
      })
      return response(200, { slots: [slot, ...noise] })
    })
    try {
      const matches = await findMssSlotsByNotePrefix('capture:key:')
      expect(matches).toHaveLength(1)
      expect(matches[0]?.note).toBe('capture:key:hash')
      foreign = true
      await expect(findMssSlotsByNotePrefix('capture:key:')).rejects.toThrow('unexpected private URL')
    } finally {
      await fixture.close()
    }
  })
})

function uploadStatus(files: number, bytes: number, complete: boolean) {
  return {
    complete,
    completed: { bytes, files },
    declared: { bytes: 5, files: 2 },
    id: 'upload-1',
  }
}

function response(status: number, body: unknown) {
  return { body, status }
}

async function startSocketServer(handler: (request: { body: Buffer; method: string; path: string }) => { body: unknown; status: number }) {
  const dir = await mkdtemp(join(tmpdir(), 'helios-mss-test-'))
  tempDirs.push(dir)
  const socketPath = join(dir, 'control.sock')
  process.env.MSS_ONE_OFFS_CONTROL_SOCKET = socketPath
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const result = handler({
        body: Buffer.concat(chunks),
        method: request.method ?? '',
        path: request.url ?? '',
      })
      const body = Buffer.from(JSON.stringify(result.body))
      response.writeHead(result.status, { 'content-length': body.byteLength, 'content-type': 'application/json' })
      response.end(body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
