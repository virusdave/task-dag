import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import cookie from '@fastify/cookie'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

import { getServerEnv } from '../config/env.js'
import { registerAuthGate } from '../auth/authGate.js'
import { startAdsDrivePoller, stopAdsDrivePoller } from '../ads/adsDrivePoller.js'
import {
  startVisitorScansNotifyListener,
  stopVisitorScansNotifyListener,
} from '../db/visitorScansNotify.js'
import { registerAdsRoutes } from '../routes/ads.js'
import { registerAdsClusterProposalsRoutes } from '../routes/adsClusterProposals.js'
import { registerAdsMorningBundlesRoutes } from '../routes/adsMorningBundles.js'
import { registerAnnotationsRoutes } from '../routes/annotations.js'
import { registerAuthRoutes } from '../routes/auth.js'
import { registerBrandExpiryOverridesRoutes } from '../routes/brandExpiryOverrides.js'
import { registerCatalogRoutes } from '../routes/catalog.js'
import { registerCatalogMaintenanceRoutes } from '../routes/catalogMaintenance.js'
import { registerCatalogLitalertsBrandOverridesRoutes } from '../routes/catalogLitalertsBrandOverrides.js'
import { registerCatalogMarketMatchRoutes } from '../routes/catalogMarketMatches.js'
import { registerCatalogReviewRoutes } from '../routes/catalogReview.js'
import { registerClientErrorsRoutes } from '../routes/clientErrors.js'
import { registerCommentsRoutes } from '../routes/comments.js'
import { registerCommunicationsRoutes } from '../routes/communications.js'
import { registerConfigRoutes } from '../routes/config.js'
import { registerConfigLitalertsParsingRoutes } from '../routes/configLitalertsParsing.js'
import { registerBudtenderAnalyticsRoutes } from '../routes/budtenderAnalytics.js'
import { registerCatalogAnalyticsRoutes } from '../routes/catalogAnalytics.js'
import { registerConfigParsingRoutes } from '../routes/configParsing.js'
import { registerCustomerReviewsRoutes } from '../routes/customerReviews.js'
import { registerCrmSegmentMetricsRoutes } from '../routes/crmSegmentMetrics.js'
import { registerCustomerValueAnalyticsRoutes } from '../routes/customerValueAnalytics.js'
import { registerGadsLandingPagesRoutes } from '../routes/gadsLandingPages.js'
import { registerInventoryProcurementRoutes } from '../routes/inventoryProcurement.js'
import { registerHistoryRoutes } from '../routes/history.js'
import { registerJobRoutes } from '../routes/jobs.js'
import { registerLlmRoutes } from '../routes/llm.js'
import { registerLpEventsRoutes } from '../routes/lpEvents.js'
import { registerMetricAnnotationsRoutes } from '../routes/metricAnnotations.js'
import { registerMetricsRoutes } from '../routes/metrics.js'
import { registerMetricsDefaultsRoutes } from '../routes/metricsDefaults.js'
import { registerTargetTrackingRoutes } from '../routes/targetTracking.js'
import { registerCatalogPurchaseSellThroughRoutes } from '../routes/catalogPurchaseSellThrough.js'
import { registerPendingPurchaseRoutes } from '../routes/pendingPurchases.js'
import { registerPricingRoutes } from '../routes/pricing.js'
import { registerProposalBatchRoutes } from '../routes/proposalBatches.js'
import { registerProposalImportRoutes } from '../routes/proposalImports.js'
import { registerReviewRoutes } from '../routes/review.js'
import { registerSchedulingRoutes } from '../routes/scheduling.js'
import { registerSeoFaqRoutes } from '../routes/seoFaq.js'
import { registerSeoImageAssetRoutes } from '../routes/seoImageAsset.js'
import { registerSeoMetricsRoutes } from '../routes/seoMetrics.js'
import { registerSeoPostRoutes } from '../routes/seoPost.js'
import { registerSeoRecommendationRoutes } from '../routes/seoRecommendation.js'
import { registerSeoSourceRoutes } from '../routes/seoSource.js'
import { registerScreensRoutes } from '../routes/screens.js'
import { registerSessionRoutes } from '../routes/session.js'
import { registerStaffRoutes } from '../routes/staff.js'
import { registerSweedAuthEventsRoutes } from '../routes/sweedAuthEvents.js'
import { registerSweedSessionsRoutes } from '../routes/sweedSessions.js'
import { registerUtilitiesPromoNamesRoutes } from '../routes/utilitiesPromoNames.js'
import { registerWarehouseLocationsRoutes } from '../routes/warehouseLocations.js'
import { registerTaskDagRoutes } from '../routes/taskDag.js'
import { registerUsersRoutes } from '../routes/users.js'
import { registerGeoSegmentRulesRoutes } from '../routes/geoSegmentRules.js'
import { registerMarketingSegmentsRoutes } from '../routes/marketingSegments.js'
import {
  registerVisitorScansAdminRoutes,
  registerVisitorScansWebhookRoutes,
} from '../routes/visitorScans.js'
import { registerCustomersMapRoutes } from '../routes/customersMap.js'
import { registerWhiteglovePricingRoutes } from '../routes/whiteglovePricing.js'
import { joinBasePath } from '../../shared/config/appBasePath.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function buildServer() {
  const env = getServerEnv()
  const server = Fastify({ logger: true })

  await server.register(cookie, {
    hook: 'onRequest',
    secret: env.sessionCookieSecret,
  })

  await server.register(fastifyMultipart, {
    attachFieldsToBody: false,
    limits: {
      fields: 20,
      fieldSize: 1024 * 1024,
      fileSize: 12 * 1024 * 1024,
      files: 1,
    },
  })

  // CORS for the public Customer-Sentiment Capture endpoints
  // (virusdave/top-level#3, Nicponskis/mostly-static-sites#5).
  //
  // The customer-facing review page is hosted on
  // `https://freshlybaked.nyc/go/<location-code>/review` and POSTs
  // to Helios's public `/v1/reviews/submit` and
  // `/v1/reviews/:id/drawing-entry` endpoints from the customer's
  // own browser. That makes it a cross-origin request, so the
  // browser sends a CORS preflight (`OPTIONS`) before the actual
  // POST. Without this hook two things would break:
  //
  //   1. The preflight `OPTIONS /v1/reviews/...` would fall through
  //      to the auth gate (which doesn't allowlist `OPTIONS` even
  //      for the public review paths) and 401.
  //   2. Even if the POST went through, the response wouldn't carry
  //      `Access-Control-Allow-Origin`, so the browser would
  //      discard the body.
  //
  // We deliberately keep this hook scoped to `/v1/reviews/` so the
  // rest of the (auth-only, single-origin) Helios surface stays
  // CORS-free. The list of allowed origins is the same
  // `env.allowedOrigins` set already used by the same-origin POST
  // guard below; the mss host names are baked into the defaults in
  // `readAllowedOrigins`.
  //
  // Must be registered BEFORE `registerAuthGate` so the OPTIONS
  // short-circuit wins over the auth gate's onRequest hook.
  server.addHook('onRequest', async (request, reply) => {
    const pathOnly = request.url.split('?', 1)[0]
    if (!pathOnly.startsWith('/v1/reviews/')) {
      return
    }
    const origin = request.headers.origin
    const isAllowed = typeof origin === 'string' && env.allowedOrigins.includes(origin)
    if (request.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, accept',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
      if (isAllowed && typeof origin === 'string') {
        headers['Access-Control-Allow-Origin'] = origin
      }
      return reply.status(204).headers(headers).send()
    }
    if (isAllowed && typeof origin === 'string') {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
    }
  })

  // Site-wide authentication gate. Must run after the cookie plugin
  // (so we can read the session cookie) but before any route handler.
  // Allows /healthzz, /api/session, /api/session/logout, and the
  // Google/dev login endpoints; everything else requires a valid
  // session. Anonymous browser navigations get 302'd into the OAuth
  // flow; everything else gets a flat 401. See authGate.ts for the
  // allowlist and the rationale.
  registerAuthGate(server)

  server.addHook('preHandler', async (request, reply) => {
    if (!isMutatingMethod(request.method) || !request.url.startsWith(joinBasePath(env.appBasePath, '/api/'))) {
      return
    }

    const origin = request.headers.origin
    if (!origin || !env.allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: 'Origin validation failed.' })
    }
  })

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed.', issues: error.issues })
    }

    const message = error instanceof Error ? error.message : 'Unknown server error.'
    return reply.status(500).send({ error: message })
  })

  // Scaffolding health check, mounted at the root so it is reachable
  // regardless of appBasePath. The trailing `zz` is the project's
  // poor-man's obfuscation marker for infrastructure-only endpoints.
  server.get('/healthzz', async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type('text/plain').send('okzz\n'),
  )

  // VeriScan webhook receivers (POST /wh/{bx,mh}/veriscan/checkin).
  // Mounted at the absolute root — NOT under appBasePath — because
  // VeriScan's webhook configuration points at fixed absolute URLs
  // (`https://helios.freshlybaked.us/wh/...`). The handlers do their
  // own `Authorization: Bearer` constant-time check against
  // VERISCAN_WEBHOOK_TOKEN and are explicitly exempted from the SPA
  // session-cookie gate in authGate.ts. See
  // virusdave/top-level#9 / FreshlyBakedNYC/automation#31 (A1).
  registerVisitorScansWebhookRoutes(server)

  if (env.appBasePath === '/') {
    await registerApplicationSurface(server)
  } else {
    await server.register(registerApplicationSurface, { prefix: env.appBasePath })
  }

  // Auto-ingest poller: scans the canonical Google Drive ads folder
  // every ~30s and runs the ingestion pipeline whenever the newest
  // CSV changes. No-ops cleanly when the API key isn't configured.
  startAdsDrivePoller()

  // Visitor-scans live feed (DB-cost epic phase E1): open the shared
  // LISTEN connection that powers the /api/visitors/scans/stream SSE
  // route. Lazy + self-reconnecting; safe to start at boot.
  void startVisitorScansNotifyListener()

  server.addHook('onClose', async () => {
    stopAdsDrivePoller()
    stopVisitorScansNotifyListener()
  })

  return server
}

async function registerApplicationSurface(server: FastifyInstance) {
  await registerSessionRoutes(server)
  await registerAuthRoutes(server)
  await registerAdsRoutes(server)
  await registerAdsClusterProposalsRoutes(server)
  await registerAdsMorningBundlesRoutes(server)
  await registerAnnotationsRoutes(server)
  await registerCatalogRoutes(server)
  await registerCatalogMaintenanceRoutes(server)
  await registerWarehouseLocationsRoutes(server)
  await registerCatalogMarketMatchRoutes(server)
  await registerCatalogLitalertsBrandOverridesRoutes(server)
  await registerCatalogReviewRoutes(server)
  await registerClientErrorsRoutes(server)
  await registerCommentsRoutes(server)
  await registerCommunicationsRoutes(server)
  await registerConfigRoutes(server)
  await registerConfigLitalertsParsingRoutes(server)
  await registerConfigParsingRoutes(server)
  await registerCustomerReviewsRoutes(server)
  await registerBrandExpiryOverridesRoutes(server)
  await registerPendingPurchaseRoutes(server)
  await registerCatalogPurchaseSellThroughRoutes(server)
  await registerPricingRoutes(server)
  await registerProposalBatchRoutes(server)
  await registerProposalImportRoutes(server)
  await registerReviewRoutes(server)
  await registerSchedulingRoutes(server)
  await registerSeoFaqRoutes(server)
  await registerSeoPostRoutes(server)
  await registerSeoImageAssetRoutes(server)
  await registerSeoMetricsRoutes(server)
  await registerSeoRecommendationRoutes(server)
  await registerSeoSourceRoutes(server)
  await registerScreensRoutes(server)
  await registerStaffRoutes(server)
  await registerSweedAuthEventsRoutes(server)
  await registerSweedSessionsRoutes(server)
  await registerUtilitiesPromoNamesRoutes(server)
  await registerHistoryRoutes(server)
  await registerLlmRoutes(server)
  await registerLpEventsRoutes(server)
  await registerMetricAnnotationsRoutes(server)
  await registerMetricsRoutes(server)
  await registerMetricsDefaultsRoutes(server)
  await registerTargetTrackingRoutes(server)
  await registerBudtenderAnalyticsRoutes(server)
  await registerCatalogAnalyticsRoutes(server)
  await registerCrmSegmentMetricsRoutes(server)
  await registerCustomerValueAnalyticsRoutes(server)
  await registerGadsLandingPagesRoutes(server)
  await registerInventoryProcurementRoutes(server)
  await registerJobRoutes(server)
  await registerTaskDagRoutes(server)
  await registerUsersRoutes(server)
  await registerGeoSegmentRulesRoutes(server)
  await registerMarketingSegmentsRoutes(server)
  await registerVisitorScansAdminRoutes(server)
  await registerCustomersMapRoutes(server)
  await registerWhiteglovePricingRoutes(server)

  const clientDistPath = resolve(__dirname, '../../../client')
  if (!existsSync(clientDistPath)) {
    return
  }

  await server.register(fastifyStatic, {
    root: clientDistPath,
    wildcard: false,
    // Don't let fastify-static auto-serve index.html for `/` — we own
    // that response below so we can set Cache-Control: no-store on the
    // SPA shell.
    index: false,
  })

  // SPA history fallback: any unmatched GET falls back to index.html so
  // client-side react-router can take over. We deliberately exclude
  // /assets/* (hashed bundles, CSS, source maps) so a stale browser tab
  // requesting a no-longer-built asset hash gets a clean 404 instead of
  // an index.html body served with text/html MIME — which the browser
  // would otherwise refuse with "Failed to load module script: Expected
  // a JavaScript-or-Wasm module script but the server responded with a
  // MIME type of 'text/html'", bricking the page across redeploys.
  // The index.html embeds hashed asset URLs, so we must never let any
  // browser (including mobile Safari's bfcache, which ignores
  // max-age=0 on back/forward + pull-to-refresh) — or Cloudflare —
  // keep a stale copy that points at an asset hash we no longer build.
  // We bypass @fastify/static.sendFile entirely (its default
  // Cache-Control: public,max-age=0 still lets browsers store the
  // document) and emit the index.html ourselves with no-store.
  const indexHtmlPath = resolve(clientDistPath, 'index.html')
  const assetsDir = resolve(clientDistPath, 'assets')
  server.get('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/assets/')) {
      // We register @fastify/static with `wildcard: false` (so it
      // doesn't claim GET /* and step on the SPA fallback), which means
      // *no* routes from that plugin actually serve /assets/* — every
      // asset request lands here. So first, try to serve the real file
      // off disk; only when the hash is genuinely missing (the symptom
      // of a stale cached HTML pointing at a since-redeployed bundle)
      // do we fall through to the recovery script below.
      const pathOnly = request.url.split('?', 1)[0] ?? request.url
      const assetRelative = pathOnly.slice('/assets/'.length)
      const assetPath = resolve(assetsDir, assetRelative)
      // Guard against path traversal (`../`) — the resolved path must
      // still live under the assets dir.
      if (assetPath === assetsDir || assetPath.startsWith(assetsDir + '/')) {
        if (existsSync(assetPath)) {
          // Vite-hashed asset URLs are content-addressed and immutable;
          // safe to cache aggressively.
          reply.header('Cache-Control', 'public, max-age=31536000, immutable')
          return reply.sendFile('assets/' + assetRelative)
        }
      }

      // A stale browser tab (especially on mobile, where the user can't
      // hard-refresh) may still be asking for an asset hash we no
      // longer build. Returning a hard 404 leaves the page blank with
      // no way to recover. Instead, for JS module requests we return a
      // tiny self-reloading module that bounces the document to a
      // cache-busted URL, which forces a fresh index.html (and thus
      // current bundle pointers) the next time the SPA loads.
      //
      // The recovery script ALWAYS replaces `_cb` (rather than
      // refusing to navigate when `_cb` is already present). The old
      // "already busted → throw" guard left the dynamic-import call
      // site stuck — the import would resolve to an empty module and
      // the catalog barcode-scan flow blew up with browser errors
      // like "Importing a module script failed". A theoretical
      // infinite reload would require the server itself to keep
      // serving stale index.html, which it can't (the SPA shell is
      // read freshly off disk on every / request).
      if (pathOnly.endsWith('.js')) {
        reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          .header('Access-Control-Allow-Origin', '*')
          .type('application/javascript; charset=utf-8')
        return reply.send(
          "// helios: stale bundle pointer, forcing a fresh document load\n" +
            "try{var u=new URL(location.href);u.searchParams.set('_cb',Date.now());location.replace(u.toString())}catch(e){try{location.reload()}catch(e2){console.error('helios stale-bundle reload failed',e,e2)}}\n",
        )
      }
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      return reply.status(404).send({ error: 'asset not found' })
    }
    const body = readFileSync(indexHtmlPath, 'utf8')
    reply
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .type('text/html; charset=utf-8')
    return reply.send(body)
  })
}

function isMutatingMethod(method: string): boolean {
  return method === 'DELETE' || method === 'PATCH' || method === 'POST' || method === 'PUT'
}
