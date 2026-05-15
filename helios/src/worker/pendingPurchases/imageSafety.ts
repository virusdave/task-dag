import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const MAX_IMAGE_REDIRECTS = 3
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

interface LookupAddressResult {
  address: string
  family: number
}

type LookupAllFunction = (hostname: string) => Promise<LookupAddressResult[]>

export interface DownloadValidatedImageInput {
  timeoutMs: number
  url: string
}

export interface DownloadValidatedImageResult {
  bytes: Uint8Array
  contentType: string
  finalUrl: string
}

export async function downloadValidatedImageAsset(
  input: DownloadValidatedImageInput,
): Promise<DownloadValidatedImageResult> {
  let currentUrl = await validatePendingPurchaseImageUrl(input.url)

  for (let redirectCount = 0; redirectCount <= MAX_IMAGE_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: { 'user-agent': 'helios-worker/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
    })

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`Image download redirect from ${currentUrl.toString()} did not provide a location.`)
      }
      if (redirectCount === MAX_IMAGE_REDIRECTS) {
        throw new Error(`Image download exceeded ${MAX_IMAGE_REDIRECTS} redirects.`)
      }

      currentUrl = await validatePendingPurchaseImageUrl(new URL(location, currentUrl).toString())
      continue
    }

    if (!response.ok) {
      throw new Error(`Image download failed for ${currentUrl.toString()}: HTTP ${response.status}.`)
    }

    const contentType = validatePendingPurchaseImageContentType(response.headers.get('content-type'))
    const contentLength = readContentLength(response.headers.get('content-length'))
    if (contentLength !== null && contentLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image download exceeded the ${MAX_IMAGE_BYTES} byte limit.`)
    }

    const bytes = await readResponseBytesWithLimit(response, MAX_IMAGE_BYTES)
    validatePendingPurchaseImageBytes(bytes, contentType)

    return {
      bytes,
      contentType,
      finalUrl: currentUrl.toString(),
    }
  }

  throw new Error('Image download did not complete.')
}

export async function validatePendingPurchaseImageUrl(
  urlString: string,
  options?: { lookupFn?: LookupAllFunction },
): Promise<URL> {
  const parsedUrl = new URL(urlString)
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Image URL must use HTTPS: ${urlString}`)
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`Image URL must not include credentials: ${urlString}`)
  }

  await assertPublicImageHost(parsedUrl.hostname, options?.lookupFn ?? lookupAllAddresses)
  return parsedUrl
}

export function validatePendingPurchaseImageContentType(contentTypeHeader: string | null): string {
  const normalizedContentType = normalizeImageContentType(contentTypeHeader)
  if (!normalizedContentType || !ALLOWED_IMAGE_CONTENT_TYPES.has(normalizedContentType)) {
    throw new Error(`Image download returned an unsupported content type: ${contentTypeHeader ?? 'unknown'}.`)
  }

  return normalizedContentType
}

export function validatePendingPurchaseImageBytes(bytes: Uint8Array, contentType: string): void {
  if (bytes.byteLength === 0) {
    throw new Error('Image download returned an empty body.')
  }

  if (!matchesImageSignature(bytes, contentType)) {
    throw new Error(`Image download bytes did not match ${contentType}.`)
  }
}

async function assertPublicImageHost(hostname: string, lookupFn: LookupAllFunction): Promise<void> {
  const normalizedHost = hostname.trim().toLowerCase()
  if (normalizedHost.length === 0) {
    throw new Error('Image URL hostname is required.')
  }
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.local')) {
    throw new Error(`Image URL host is not allowed: ${hostname}`)
  }

  const literalIpFamily = isIP(normalizedHost)
  if (literalIpFamily > 0) {
    if (!isPublicIpAddress(normalizedHost)) {
      throw new Error(`Image URL host is not public: ${hostname}`)
    }
    return
  }

  const addresses = await lookupFn(normalizedHost)
  if (addresses.length === 0) {
    throw new Error(`Could not resolve image URL host: ${hostname}`)
  }

  for (const address of addresses) {
    if (!isPublicIpAddress(address.address)) {
      throw new Error(`Image URL host resolved to a non-public address: ${hostname}`)
    }
  }
}

async function lookupAllAddresses(hostname: string): Promise<LookupAddressResult[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    return isPublicIpv4Address(address)
  }
  if (family === 6) {
    return isPublicIpv6Address(address)
  }
  return false
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) {
    return false
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false
  }
  if (a === 169 && b === 254) {
    return false
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false
  }
  if (a === 192 && b === 0) {
    return false
  }
  if (a === 192 && b === 168) {
    return false
  }
  if (a >= 224) {
    return false
  }

  return true
}

function isPublicIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') {
    return false
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return false
  }
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return false
  }
  if (normalized.startsWith('ff')) {
    return false
  }
  if (normalized.startsWith('::ffff:')) {
    const embeddedIpv4 = normalized.slice('::ffff:'.length)
    return isPublicIpv4Address(embeddedIpv4)
  }

  return true
}

function normalizeImageContentType(contentTypeHeader: string | null): string | null {
  if (!contentTypeHeader) {
    return null
  }

  const normalized = contentTypeHeader.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (normalized === 'image/jpg') {
    return 'image/jpeg'
  }

  return normalized || null
}

function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/png':
      return bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
    case 'image/gif':
      return bytes.length >= 6
        && bytes[0] === 0x47
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39)
        && bytes[5] === 0x61
    case 'image/webp':
      return bytes.length >= 12
        && bytes[0] === 0x52
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x46
        && bytes[8] === 0x57
        && bytes[9] === 0x45
        && bytes[10] === 0x42
        && bytes[11] === 0x50
    default:
      return false
  }
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const fallbackBytes = new Uint8Array(await response.arrayBuffer())
    if (fallbackBytes.byteLength > maxBytes) {
      throw new Error(`Image download exceeded the ${maxBytes} byte limit.`)
    }
    return fallbackBytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (!value) {
      continue
    }

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`Image download exceeded the ${maxBytes} byte limit.`)
    }
    chunks.push(value)
  }

  const mergedBytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    mergedBytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return mergedBytes
}

function readContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null
  }

  const parsed = Number.parseInt(contentLengthHeader, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
