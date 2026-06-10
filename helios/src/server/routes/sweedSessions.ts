/**
 * Operator surface for the Sweed session-token POOL.
 *
 *   GET  /api/sweed/sessions            — list pool rows (history +
 *                                         availability), tokens masked
 *                                         to their 8-char prefix.
 *   POST /api/sweed/sessions            — paste a new session UUID into
 *                                         the pool. By default the token
 *                                         is validated against Sweed with
 *                                         a no-op store.auth.initial.data.get
 *                                         BEFORE it is committed, so a dead
 *                                         token is rejected with a clear
 *                                         error instead of silently
 *                                         expiring on the first worker pickup.
 *   POST /api/sweed/sessions/:id/expire — permanently retire one pool row.
 *
 * Workers claim/release rows out of this pool via withSweedSession();
 * this is the human-facing half that keeps the pool stocked. See
 * docs/sweed/getting-a-token-for-one-offs.md.
 */

import type { FastifyInstance } from 'fastify'

import {
  ExpireSweedSessionRequestSchema,
  PasteSweedSessionRequestSchema,
  PasteSweedSessionResponseSchema,
  SweedSessionsResponseSchema,
} from '../../shared/contracts/index.js'
import { postSweedRpc } from '../../worker/sweed/transport.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  insertSweedSessionToken,
  listSweedSessionTokens,
  markSweedSessionTokenExpired,
} from '../db/queries/sweedSessionTokensQueries.js'

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

interface SweedInitialDataResponse {
  user?: { currentDealerId?: unknown }
}

/**
 * Operators copy the raw `auth=...` cookie value out of a logged-in
 * Sweed browser tab. Accept either the bare UUID or the full
 * `auth=<uuid>` form and normalize to just the UUID we POST as the
 * `auth` field on every JSON-RPC call.
 */
function normalizePastedToken(raw: string): string {
  let token = raw.trim()
  if (token.toLowerCase().startsWith('auth=')) {
    token = token.slice('auth='.length).trim()
  }
  // Tolerate a trailing semicolon if the operator grabbed the whole
  // `auth=...;` cookie segment.
  if (token.endsWith(';')) {
    token = token.slice(0, -1).trim()
  }
  return token
}

function coerceDealerId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }
  return null
}

export async function registerSweedSessionsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/sweed/sessions', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const rawLimit = Number((request.query as { limit?: unknown } | undefined)?.limit)
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT

    const response = await listSweedSessionTokens(getPool(), { limit, revealActiveToken: false })
    return reply.send(SweedSessionsResponseSchema.parse(response))
  })

  server.post('/api/sweed/sessions', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = PasteSweedSessionRequestSchema.parse(request.body)
    const token = normalizePastedToken(body.token)
    if (token.length < 8) {
      return reply.status(400).send({ error: 'Pasted Sweed session token is too short after normalization.' })
    }

    // Validate-before-commit: prove the token is alive with a no-op
    // read so we never seed a dead row that workers would just expire
    // on first pickup. `postSweedRpc` with an explicit authToken does
    // NOT touch the pool (no claim, no auth-error retirement), so this
    // is a pure probe of the pasted token.
    let initialDealerId: number | null = null
    if (body.validate) {
      try {
        const initialData = await postSweedRpc<SweedInitialDataResponse>({
          authToken: token,
          name: 'store.auth.initial.data.get',
        })
        initialDealerId = coerceDealerId(initialData.user?.currentDealerId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return reply.status(400).send({
          error: 'Sweed rejected this session token; it is expired or invalid. Capture a fresh session and retry.',
          detail: message,
        })
      }
    }

    const active = await insertSweedSessionToken(getPool(), {
      token,
      tokenPrefix: token.slice(0, 8),
      label: body.label ?? null,
      source: body.source,
      createdByUserId: user.id,
      initialDealerId,
    })

    return reply.send(PasteSweedSessionResponseSchema.parse({ active, ok: true }))
  })

  server.post<{ Params: { id: string } }>('/api/sweed/sessions/:id/expire', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const id = Number(request.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Invalid session token id.' })
    }

    const body = ExpireSweedSessionRequestSchema.parse(request.body ?? {})
    const reason = body.reason ?? `Manually retired by ${user.name ?? `user ${user.id}`}.`
    await markSweedSessionTokenExpired(getPool(), id, reason)

    return reply.send({ ok: true })
  })
}
