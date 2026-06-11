import { createHash } from 'node:crypto'

/** Lowercase hex sha256 of the given bytes/string. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}
