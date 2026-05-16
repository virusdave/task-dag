import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import cookie from '@fastify/cookie'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

import { getServerEnv } from '../config/env.js'
import { registerAnnotationsRoutes } from '../routes/annotations.js'
import { registerAuthRoutes } from '../routes/auth.js'
import { registerCatalogRoutes } from '../routes/catalog.js'
import { registerCatalogMaintenanceRoutes } from '../routes/catalogMaintenance.js'
import { registerCatalogReviewRoutes } from '../routes/catalogReview.js'
import { registerCommentsRoutes } from '../routes/comments.js'
import { registerCommunicationsRoutes } from '../routes/communications.js'
import { registerConfigRoutes } from '../routes/config.js'
import { registerHistoryRoutes } from '../routes/history.js'
import { registerJobRoutes } from '../routes/jobs.js'
import { registerLlmRoutes } from '../routes/llm.js'
import { registerPendingPurchaseRoutes } from '../routes/pendingPurchases.js'
import { registerPricingRoutes } from '../routes/pricing.js'
import { registerProposalBatchRoutes } from '../routes/proposalBatches.js'
import { registerProposalImportRoutes } from '../routes/proposalImports.js'
import { registerReviewRoutes } from '../routes/review.js'
import { registerSchedulingRoutes } from '../routes/scheduling.js'
import { registerScreensRoutes } from '../routes/screens.js'
import { registerSessionRoutes } from '../routes/session.js'
import { registerTaskDagRoutes } from '../routes/taskDag.js'
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

  if (env.appBasePath === '/') {
    await registerApplicationSurface(server)
  } else {
    await server.register(registerApplicationSurface, { prefix: env.appBasePath })
  }

  return server
}

async function registerApplicationSurface(server: FastifyInstance) {
  await registerSessionRoutes(server)
  await registerAuthRoutes(server)
  await registerAnnotationsRoutes(server)
  await registerCatalogRoutes(server)
  await registerCatalogMaintenanceRoutes(server)
  await registerCatalogReviewRoutes(server)
  await registerCommentsRoutes(server)
  await registerCommunicationsRoutes(server)
  await registerConfigRoutes(server)
  await registerPendingPurchaseRoutes(server)
  await registerPricingRoutes(server)
  await registerProposalBatchRoutes(server)
  await registerProposalImportRoutes(server)
  await registerReviewRoutes(server)
  await registerSchedulingRoutes(server)
  await registerScreensRoutes(server)
  await registerHistoryRoutes(server)
  await registerLlmRoutes(server)
  await registerJobRoutes(server)
  await registerTaskDagRoutes(server)

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
  server.get('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/assets/')) {
      // A stale browser tab (especially on mobile, where the user can't
      // hard-refresh) may still be asking for an asset hash we no
      // longer build. Returning a hard 404 leaves the page blank with
      // no way to recover. Instead, for JS module requests we return a
      // tiny self-reloading module that bounces the document to a
      // cache-busted URL, which forces a fresh index.html (and thus
      // current bundle pointers) the next time the SPA loads.
      if (request.url.endsWith('.js')) {
        reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          .type('application/javascript; charset=utf-8')
        return reply.send(
          "// helios: stale bundle pointer, forcing a fresh document load\n" +
            "try{var u=new URL(location.href);if(u.searchParams.has('_cb')){throw new Error('already busted')}u.searchParams.set('_cb',Date.now());location.replace(u.toString())}catch(e){console.error('helios stale-bundle reload failed',e)}\n",
        )
      }
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
