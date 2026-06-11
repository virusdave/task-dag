// Deterministic JSON serialization for signing / hashing payloads.
//
// Object keys are emitted in sorted order, recursively; arrays keep
// their order. Output is compact (no insignificant whitespace) so the
// exact bytes are reproducible across processes and Node versions —
// which is what makes ed25519 signatures and sha256 checksums verify.
//
// This is used for the SIGNED payloads (manifest-minus-signature, the
// pointer signing payload). Artifact file checksums are taken over the
// actual bytes written to disk (see publish.ts), so a reader hashes the
// raw file rather than re-serializing it.

export function canonicalJsonStringify(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalJson: non-finite number')
    }
    return JSON.stringify(value)
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'undefined' || t === 'function') {
    throw new Error(`canonicalJson: unsupported value of type ${t}`)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`
  }
  // Plain object: sort keys, drop undefined-valued keys (matches JSON).
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`)
  return `{${parts.join(',')}}`
}
