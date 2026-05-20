/**
 * Single-page-app error reporting endpoint.
 *
 * The mobile UI (specifically the catalog Images & Barcodes flow) used
 * to dump raw upload / worker / network error text directly into the
 * operator's face, which is both scary on a tiny phone screen and
 * unactionable — the operator can't do anything about "Sweed accepted
 * store.product.group.edit but the blob is not present in refreshed
 * image list". Instead, the client now POSTs unactionable errors here
 * and we (a) audit-log them and (b) page Dave so we actually find out
 * about the breakage in real time.
 *
 * Pages are deduplicated by a short fingerprint of {context, message}
 * within a 10-minute window so a flapping upload doesn't blow up our
 * phones.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireSessionUser } from '../auth/requireSession.js'
import { pageDave } from '../../worker/runtime/pageDave.js'

const ClientErrorReportSchema = z.object({
  // Short tag identifying where the error happened, e.g.
  // 'catalog.maintenance.upload', 'catalog.maintenance.poll',
  // 'catalog.maintenance.barcode-scan'.
  context: z.string().trim().min(1).max(200),
  // Free-form summary of the failure (HTTP status + body, fetch
  // throw, worker lastError, etc.).
  message: z.string().trim().min(1).max(4000),
  // Optional structured detail the server can include in the page
  // text (group id, site, jobId, stagedRef, etc.). Kept small.
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
})

interface RecentPage {
  firedAt: number
}

const DEDUP_WINDOW_MS = 10 * 60 * 1000
const recentPages = new Map<string, RecentPage>()

export async function registerClientErrorsRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/client-errors', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const body = ClientErrorReportSchema.parse(request.body ?? {})
    const userAgent = (request.headers['user-agent'] ?? '').toString().slice(0, 200)

    const fingerprint = `${body.context}::${body.message.slice(0, 200)}`
    const now = Date.now()
    const previous = recentPages.get(fingerprint)
    pruneRecentPages(now)

    // Always log so we can grep journals for the full event even when
    // we suppress the page.
    request.log.warn(
      {
        clientError: {
          context: body.context,
          message: body.message,
          detail: body.detail ?? null,
          userId: user.id,
          userEmail: user.email,
          userAgent,
        },
      },
      'client reported unactionable error',
    )

    if (previous && now - previous.firedAt < DEDUP_WINDOW_MS) {
      return reply.send({ ok: true, paged: false, reason: 'duplicate-within-window' })
    }
    recentPages.set(fingerprint, { firedAt: now })

    const pageText = buildPageMessage(body, user.email, userAgent)
    try {
      await pageDave(pageText)
      return reply.send({ ok: true, paged: true })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      request.log.error({ err: errMsg }, 'pageDave failed for client-error report')
      // We do NOT bubble this back to the mobile client — they already
      // can't act on the underlying upload error; surfacing "we also
      // failed to page Dave" would be even less actionable.
      return reply.send({ ok: true, paged: false, reason: 'page-dave-failed' })
    }
  })
}

function buildPageMessage(
  body: z.infer<typeof ClientErrorReportSchema>,
  userEmail: string,
  userAgent: string,
): string {
  const detailPairs = body.detail
    ? Object.entries(body.detail)
        .map(([k, v]) => `${k}=${v ?? '∅'}`)
        .join(' ')
    : ''
  const lines = [
    `[helios mobile] ${body.context}`,
    `user: ${userEmail}`,
    `msg: ${body.message.slice(0, 400)}`,
  ]
  if (detailPairs) lines.push(`detail: ${detailPairs}`)
  if (userAgent) lines.push(`ua: ${userAgent.slice(0, 120)}`)
  return lines.join('\n')
}

function pruneRecentPages(now: number): void {
  for (const [key, value] of recentPages.entries()) {
    if (now - value.firedAt > DEDUP_WINDOW_MS) recentPages.delete(key)
  }
}
