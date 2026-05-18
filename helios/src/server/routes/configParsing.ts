/**
 * Helios server routes backing the Config -> Parsing pages.
 *
 * For now only `pending-purchases` is implemented; future siblings
 * (LitAlerts, CompetitorEcom) will plug in next to it.
 */

import type { FastifyInstance } from 'fastify'

import {
  ConfigParsingPendingPurchasesResponseSchema,
  type ParsekitReverseShadowEvent,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  loadParsekitReverseShadowCounts,
  loadRecentParsekitReverseShadowEvents,
} from '../db/queries/parsekitReverseShadowQueries.js'
import { getParserRegistry } from '../../lib/parsekit/node/parserRegistry.js'

const RECENT_LIMIT = 50

export async function registerConfigParsingRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/parsing/pending-purchases', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const [recent, counts24h, counts1h, countsAllTime] = await Promise.all([
      loadRecentParsekitReverseShadowEvents(RECENT_LIMIT),
      loadParsekitReverseShadowCounts(24 * 60 * 60),
      loadParsekitReverseShadowCounts(60 * 60),
      loadParsekitReverseShadowCounts(60 * 60 * 24 * 365 * 100), // ~ all time
    ])

    const registry = getParserRegistry()
    const status = registry.getStatus()
    const release = registry.current()

    const parsers = release
      ? Array.from(release.parsers.values())
          .filter((p) => p.config.scope.useCase === 'pending-purchases')
          .map((p) => ({
            parserId: p.config.parserId,
            tenantId: p.config.scope.tenantId,
            useCase: p.config.scope.useCase,
            prefixes: p.config.detect.prefixes ?? [],
          }))
      : []

    const recentSerialized: ParsekitReverseShadowEvent[] = recent.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      kind: row.kind,
      input: row.input,
      parserId: row.parserId,
      ruleId: row.ruleId,
      snapshotSha: row.snapshotSha,
      diffFields: row.diffFields,
      parsekitOutput: row.parsekitOutput,
      legacyOutput: row.legacyOutput,
      parsekitFailureReason: row.parsekitFailureReason,
      legacyError: row.legacyError,
    }))

    return reply.send(
      ConfigParsingPendingPurchasesResponseSchema.parse({
        registry: {
          initialized: status.initialized,
          sha: status.sha,
          loadedAtMs: status.loadedAtMs,
          parsersLoaded: release?.parsers.size ?? 0,
          lastAttemptAtMs: status.lastAttemptAtMs,
          successfulLoads: status.successfulLoads,
          failedLoads: status.failedLoads,
          lastErrors: status.lastErrors.map((e) =>
            typeof (e as { message?: string }).message === 'string'
              ? (e as { message: string }).message
              : JSON.stringify(e),
          ),
          parsers,
        },
        countsLast24h: counts24h,
        countsLast1h: counts1h,
        countsAllTime,
        recent: recentSerialized,
      }),
    )
  })
}
