/**
 * Config → LitAlerts → Parsing live-review API (issue #19 L3 + chat
 * teaser of L5).
 *
 *   GET  /api/config/parsing/litalerts                 — competitor list
 *   GET  /api/config/parsing/litalerts/:competitor     — recent sample
 *                                                        + emitted FuzzySku
 *   POST /api/config/parsing/litalerts/:competitor/chat
 *                                                       — advisory LLM
 *                                                        suggestion. Does
 *                                                        NOT commit /
 *                                                        push the patch
 *                                                        yet; that's L5
 *                                                        work. Returns
 *                                                        rationale +
 *                                                        suggested
 *                                                        JSONC patch the
 *                                                        operator can
 *                                                        copy into the
 *                                                        helios-parser-
 *                                                        configs repo
 *                                                        by hand for now.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireSessionUser } from '../auth/requireSession.js'
import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import {
  listLitalertsCompetitors,
  loadCompetitorSample,
} from '../db/queries/litalertsCompetitorsQueries.js'

const CHAT_MODEL = 'google.gemma-3-27b-it'

const ChatRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  selectedListingHashes: z.array(z.string().trim().min(1)).default([]),
})

export async function registerConfigLitalertsParsingRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/parsing/litalerts', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const competitors = await listLitalertsCompetitors(getPool(), { limit: 50 })
    return reply.send({ competitors })
  })

  server.get<{ Params: { competitor: string }; Querystring: { limit?: string } }>(
    '/api/config/parsing/litalerts/:competitor',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return

      const competitorName = decodeURIComponent(request.params.competitor)
      const limit = request.query.limit ? Math.min(200, Math.max(1, Number.parseInt(request.query.limit, 10))) : 25
      const sample = await loadCompetitorSample(getPool(), competitorName, { limit })
      return reply.send({ competitorName, sample })
    },
  )

  server.post<{ Params: { competitor: string } }>(
    '/api/config/parsing/litalerts/:competitor/chat',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return

      const competitorName = decodeURIComponent(request.params.competitor)
      const body = ChatRequestSchema.parse(request.body ?? {})
      const env = getServerEnv()
      if (!env.bedrockMantleBearerToken) {
        return reply.code(503).send({
          error: 'bedrock_unconfigured',
          message: 'BEDROCK_MANTLE_BEARER_TOKEN is not set on this server.',
        })
      }

      // Pull the latest sample so the prompt always reflects current
      // data; filter to the operator-selected subset when they
      // narrowed scope.
      const sample = await loadCompetitorSample(getPool(), competitorName, { limit: 50 })
      const focused = body.selectedListingHashes.length > 0
        ? sample.filter((row) => body.selectedListingHashes.includes(row.fuzzyHash))
        : sample.slice(0, 12)

      const systemPrompt = [
        'You are an assistant for tuning Helios LitAlerts parser configurations.',
        'Helios stores parser configs in the helios-parser-configs repo at use-cases/litalerts/parsers/<competitorId>.jsonc.',
        'The output schema for a LitAlerts FuzzySku is { brandNorm, categoryNorm, subcategoryNorm, sizeGNorm, sizeMgNorm, packCountNorm, strainNorm }.',
        'The operator will describe an inadequacy in the current parser output for a specific competitor, and show you the raw upstream listings + the current parser output.',
        'Propose a precise change: either a JSONC patch (with diff-style + / - lines) to the competitor\'s parser config, or a description of a new transform that the dialect needs to add.',
        'Return STRICT JSON with this shape, no markdown fences, no prose outside the JSON:',
        '{"rationale": "<2-4 sentence explanation>", "patch": "<diff-style JSONC patch or natural-language description, max 1500 chars>", "newGoldensSuggested": [{"listingName": string, "expected": object}]}',
      ].join(' ')

      const userPrompt = [
        `competitor: ${competitorName}`,
        '',
        'operator description:',
        body.prompt,
        '',
        'current parser output samples (raw_listing + parsed FuzzySku):',
        JSON.stringify(
          focused.map((row) => ({
            raw: { listingName: row.raw.listingName, category: row.raw.category, brand: row.raw.brand },
            parsed: row.parsed,
            searchTerm: row.searchTerm,
          })),
          null,
          2,
        ),
      ].join('\n')

      try {
        const response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
          body: JSON.stringify({
            max_tokens: 1500,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            model: CHAT_MODEL,
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
          headers: {
            Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
        })
        if (!response.ok) {
          const text = await response.text()
          return reply.code(502).send({
            error: 'bedrock_http_error',
            message: `HTTP ${response.status}: ${text.slice(0, 500)}`,
          })
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = payload.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          return reply.code(502).send({
            error: 'bedrock_unexpected_response',
            message: 'LLM gateway response did not include message content.',
            raw: payload,
          })
        }
        let parsed: { rationale?: unknown; patch?: unknown; newGoldensSuggested?: unknown } = {}
        try {
          parsed = JSON.parse(content)
        } catch {
          return reply.send({
            modelRef: CHAT_MODEL,
            ok: false,
            rationale: 'LLM returned non-JSON content; showing raw text.',
            patch: content.slice(0, 1500),
            newGoldensSuggested: [],
          })
        }
        return reply.send({
          modelRef: CHAT_MODEL,
          ok: true,
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          patch: typeof parsed.patch === 'string' ? parsed.patch : '',
          newGoldensSuggested: Array.isArray(parsed.newGoldensSuggested) ? parsed.newGoldensSuggested : [],
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return reply.code(502).send({ error: 'bedrock_transport_error', message })
      }
    },
  )
}
