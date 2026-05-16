import { existsSync } from 'node:fs'
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
  })

  server.get('/*', async (_request: FastifyRequest, reply: FastifyReply) => reply.sendFile('index.html'))
}

function isMutatingMethod(method: string): boolean {
  return method === 'DELETE' || method === 'PATCH' || method === 'POST' || method === 'PUT'
}
