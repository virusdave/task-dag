// ed25519 signing/verification for landing-page artifacts.
//
// Signing keys live with Helios only — NEVER on the shared /cloud mount
// (parent EPIC_PLAN §5, decision 5). The private key is provided as a
// PKCS#8 PEM string, typically loaded from an env var or operator-only
// file by the caller; this module never reads /cloud.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'

const SIG_PREFIX = 'ed25519:'

/** Generate an ed25519 keypair as PEM strings (dev/test/key-rotation). */
export function generateEd25519Pem(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

function toPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem)
}

function toPublicKey(pem: string): KeyObject {
  return createPublicKey(pem)
}

/** Sign `payload`, returning the canonical `ed25519:<base64>` string. */
export function signPayload(payload: Buffer | string, privateKeyPem: string): string {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const sig = cryptoSign(null, data, toPrivateKey(privateKeyPem))
  return SIG_PREFIX + sig.toString('base64')
}

/**
 * Verify an `ed25519:<base64>` signature over `payload`. Returns false
 * (never throws) on any malformed input — callers fail closed.
 */
export function verifyPayload(
  payload: Buffer | string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    if (!signature.startsWith(SIG_PREFIX)) return false
    const sig = Buffer.from(signature.slice(SIG_PREFIX.length), 'base64')
    if (sig.length === 0) return false
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
    return cryptoVerify(null, data, toPublicKey(publicKeyPem), sig)
  } catch {
    return false
  }
}

/** Derive the SPKI public-key PEM from a PKCS#8 private-key PEM. */
export function publicKeyPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(toPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString()
}
