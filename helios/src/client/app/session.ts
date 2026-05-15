import { SessionEnvelopeSchema, type SessionEnvelope } from '../../shared/contracts/index.js'
import { loadJson } from './fetchJson.js'

export async function loadSession(): Promise<SessionEnvelope> {
  return loadJson('/api/session', SessionEnvelopeSchema)
}
