import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * In-process port of scripts/upload-to-mss (the bash uploader).
 *
 * Stages the file under /var/lib/mss-one-offs/incoming/<uploadId>/index.html
 * and POSTs a slot-claim to the mss-one-offs control socket. Returns
 * the public URL on success.
 *
 * Configurable via env so dev hosts that don't run mss-one-offs can
 * point at an alternate staging dir + socket:
 *   MSS_ONE_OFFS_INCOMING_DIR   default: /var/lib/mss-one-offs/incoming
 *   MSS_ONE_OFFS_CONTROL_SOCKET default: /run/mss-one-offs/control.sock
 */

const DEFAULT_INCOMING_DIR = '/var/lib/mss-one-offs/incoming'
const DEFAULT_CONTROL_SOCKET = '/run/mss-one-offs/control.sock'

export interface MssUploadResult {
  publicUrl: string
  uploadId: string
}

export class MssUploadError extends Error {}

export async function uploadToMssOneOffs(args: {
  sourcePath: string
  note: string
  ttlSeconds: number
}): Promise<MssUploadResult> {
  const incomingRoot = process.env.MSS_ONE_OFFS_INCOMING_DIR?.trim() || DEFAULT_INCOMING_DIR
  const socketPath = process.env.MSS_ONE_OFFS_CONTROL_SOCKET?.trim() || DEFAULT_CONTROL_SOCKET

  const uploadId = `upload-${stampNow()}-${crypto.randomBytes(4).toString('hex')}`
  const incomingDir = path.join(incomingRoot, uploadId)
  await fs.mkdir(incomingDir, { recursive: true })
  const dest = path.join(incomingDir, 'index.html')
  await fs.copyFile(args.sourcePath, dest)

  const payload = JSON.stringify({
    uploadId,
    ttlSeconds: args.ttlSeconds,
    requestedBy: os.userInfo().username,
    note: args.note,
  })

  const body = await unixSocketPostJson({
    socketPath,
    path: '/v1/slots',
    payload,
  })

  let parsed: { url?: string; error?: string }
  try {
    parsed = JSON.parse(body) as { url?: string; error?: string }
  } catch (err) {
    throw new MssUploadError(
      `mss-one-offs returned non-JSON: ${body.slice(0, 400)} (parse err: ${(err as Error).message})`,
    )
  }
  if (parsed.error) {
    throw new MssUploadError(`mss-one-offs rejected slot claim: ${parsed.error}`)
  }
  if (!parsed.url) {
    throw new MssUploadError(`mss-one-offs returned no url: ${body.slice(0, 400)}`)
  }
  return { publicUrl: parsed.url, uploadId }
}

function stampNow(): string {
  // Format: YYYYMMDD-HHMMSS in local time, matching the bash version
  // (which used `date +%Y%m%d-%H%M%S` without -u).
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function unixSocketPostJson(args: {
  socketPath: string
  path: string
  payload: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: args.socketPath,
        path: args.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(args.payload).toString(),
          host: 'localhost',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new MssUploadError(
                `mss-one-offs ${args.path} returned ${res.statusCode}: ${text.slice(0, 400)}`,
              ),
            )
            return
          }
          resolve(text)
        })
        res.on('error', (err) => reject(new MssUploadError(`mss-one-offs response error: ${err.message}`)))
      },
    )
    req.on('error', (err) => {
      reject(
        new MssUploadError(
          `mss-one-offs control socket (${args.socketPath}) unreachable: ${err.message}`,
        ),
      )
    })
    req.write(args.payload)
    req.end()
  })
}
