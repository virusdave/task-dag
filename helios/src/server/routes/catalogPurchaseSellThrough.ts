import type { FastifyInstance } from 'fastify'

import {
  CatalogPurchaseDetailResponseSchema,
  CatalogPurchaseLineDetailResponseSchema,
  CatalogPurchaseListRequestSchema,
  CatalogPurchaseListResponseSchema,
  CatalogPurchasePaymentRequestSchema,
  CatalogPurchasePaymentResponseSchema,
} from '../../shared/contracts/index.js'
import { HELIOS_RETAIL_TZ } from '../../shared/contracts/domain/businessDay.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  PoDetailSchema,
  normaliseHeader,
  normaliseLine,
  upsertPurchase,
} from '../catalogPurchaseSellThrough/purchaseMirrorUpsert.js'
import {
  getCatalogPurchaseDetail,
  getCatalogPurchaseLineDetail,
  getCatalogPurchaseList,
} from '../catalogPurchaseSellThrough/catalogPurchaseQueries.js'
import { getPool, withClient } from '../db/pool.js'

// Money is reconciled in integer cents so float representation can never
// leave a stray cent on a "fully paid" PO.
function toCents(dollars: number | null | undefined): number {
  return Math.round((dollars ?? 0) * 100)
}
function fromCents(cents: number): number {
  return cents / 100
}

function nyToday(): string {
  // en-CA formats as YYYY-MM-DD; pinned to the retail timezone so the
  // payTime matches the day the operator is actually working.
  return new Intl.DateTimeFormat('en-CA', { timeZone: HELIOS_RETAIL_TZ }).format(new Date())
}

export async function registerCatalogPurchaseSellThroughRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/catalog/purchases?sites=&distributorNames=&deliveryFrom=&deliveryTo=&…
  server.get('/api/catalog/purchases', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const parsed = CatalogPurchaseListRequestSchema.parse(request.query ?? {})
    const result = await getCatalogPurchaseList(parsed)
    return reply.send(CatalogPurchaseListResponseSchema.parse(result))
  })

  // GET /api/catalog/purchases/:poId?dealerId=...
  server.get<{
    Params: { poId: string }
    Querystring: { dealerId?: string }
  }>('/api/catalog/purchases/:poId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const dealerIdRaw = request.query.dealerId
    const dealerId = dealerIdRaw ? Number(dealerIdRaw) : NaN
    if (!Number.isFinite(dealerId)) {
      return reply.code(400).send({ error: 'dealerId query param required' })
    }
    const result = await getCatalogPurchaseDetail({ dealerId, poId: request.params.poId })
    if (!result) return reply.code(404).send({ error: 'Purchase not found' })
    return reply.send(CatalogPurchaseDetailResponseSchema.parse(result))
  })

  // POST /api/catalog/purchases/:poId/payments
  //
  // Records an operator payment against a PO directly in Sweed (RPC
  // `store.purchase.order.payment.add`), then re-mirrors the returned PO
  // into our tables so the page reflects the new financial status. See
  // CatalogPurchasePaymentRequestSchema for the "mark fully paid →
  // unpayable-balance Check" workflow.
  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/payments',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return

      const poId = request.params.poId
      const body = CatalogPurchasePaymentRequestSchema.parse(request.body ?? {})
      const { dealerId, orderPaymentTypeId, markFullyPaid } = body
      const payTime = body.payTime ?? nyToday()
      const payAmountCents = toCents(body.payAmount)

      if (!markFullyPaid && payAmountCents <= 0) {
        return reply
          .code(400)
          .send({ error: 'payAmount must be greater than $0 for a partial payment' })
      }

      // Confirm the PO exists in our mirror and capture its site_key for
      // the re-mirror. (Virtual POs are hidden everywhere, including here.)
      const headerRes = await getPool().query<{ site_key: string }>(
        `select site_key from sweed_purchases
          where dealer_id = $1 and po_id = $2
            and coalesce(external_order_id, '') !~* '^#?V[0-9]+_N[0-9]+'`,
        [dealerId, poId],
      )
      if (headerRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Purchase not found' })
      }
      const siteKey = headerRes.rows[0]!.site_key

      // Per-PO advisory lock: a stale tab or double-click cannot fire two
      // concurrent payment writes against the same PO. Held on a single
      // pooled client for the whole operation, released in finally.
      const lockKeyA = 'catalog_purchase_payment'
      const lockKeyB = `${dealerId}:${poId}`
      try {
        return await withClient(async (client) => {
          const lockRes = await client.query<{ locked: boolean }>(
            `select pg_try_advisory_lock(hashtext($1), hashtext($2)) as locked`,
            [lockKeyA, lockKeyB],
          )
          if (!lockRes.rows[0]?.locked) {
            return reply
              .code(409)
              .send({ error: 'Another payment for this PO is already in progress. Try again.' })
          }
          try {
            const outcome = await withSweedSession(async () => {
              // 1) Live owed from Sweed — never trust the mirror for a write.
              const liveRaw = await callSweedRpc<unknown>(
                dealerId,
                'store.purchase.order.get',
                { id: poId },
              )
              const live = PoDetailSchema.parse(liveRaw)
              const liveOwedCents = toCents(live.totalOwedAmount)

              if (liveOwedCents <= 0) {
                return { kind: 'error' as const, code: 400, message: 'This PO has nothing owed.' }
              }
              if (payAmountCents > liveOwedCents) {
                return {
                  kind: 'error' as const,
                  code: 400,
                  message: `payAmount ($${fromCents(payAmountCents).toFixed(2)}) exceeds the amount owed ($${fromCents(liveOwedCents).toFixed(2)}).`,
                }
              }
              if (
                body.expectedOwedDollars !== undefined &&
                Math.abs(toCents(body.expectedOwedDollars) - liveOwedCents) > 1
              ) {
                return {
                  kind: 'error' as const,
                  code: 409,
                  message: `Owed amount changed in Sweed (now $${fromCents(liveOwedCents).toFixed(2)}). Refresh and retry.`,
                }
              }

              let latest = live
              let owedAfterCents = liveOwedCents

              // 2) Record the operator's actual payment (skip a $0 no-op).
              if (payAmountCents > 0) {
                const resp1Raw = await callSweedRpc<unknown>(
                  dealerId,
                  'store.purchase.order.payment.add',
                  {
                    payAmount: fromCents(payAmountCents),
                    orderPaymentTypeId,
                    orderPaymentPurposeId: 1,
                    payTime,
                    id: poId,
                  },
                )
                latest = PoDetailSchema.parse(resp1Raw)
                owedAfterCents = toCents(latest.totalOwedAmount)
              }

              // 3) Mark-fully-paid top-up: write the remainder as a Check
              //    with the "unpayable balance" note, zeroing the PO out.
              let checkCents: number | null = null
              if (markFullyPaid && owedAfterCents > 0) {
                checkCents = owedAfterCents
                const resp2Raw = await callSweedRpc<unknown>(
                  dealerId,
                  'store.purchase.order.payment.add',
                  {
                    payAmount: fromCents(owedAfterCents),
                    orderPaymentTypeId: 3,
                    orderPaymentPurposeId: 1,
                    paymentNumber: 'unpayable balance',
                    payTime,
                    id: poId,
                  },
                )
                latest = PoDetailSchema.parse(resp2Raw)
                owedAfterCents = toCents(latest.totalOwedAmount)
              }

              if (markFullyPaid && owedAfterCents !== 0) {
                return {
                  kind: 'error' as const,
                  code: 502,
                  message: `Payment(s) were recorded in Sweed but the PO still shows $${fromCents(owedAfterCents).toFixed(2)} owed. Do not retry blindly — refresh the PO and review.`,
                }
              }

              // 4) Make sure the response carries the line items before we
              //    re-mirror, so we never blank out the lines.
              if (!latest.positions || latest.positions.length === 0) {
                const refetched = await callSweedRpc<unknown>(
                  dealerId,
                  'store.purchase.order.get',
                  { id: poId },
                )
                latest = PoDetailSchema.parse(refetched)
              }

              const header = normaliseHeader(dealerId, siteKey, latest)
              const lines = (latest.positions ?? []).map((p, idx) => normaliseLine(idx, p))
              await upsertPurchase(header, lines)

              return {
                kind: 'ok' as const,
                checkCents,
                owedAfterCents,
                financialStatusName: latest.financialStatus?.name ?? null,
              }
            })

            if (outcome.kind === 'error') {
              return reply.code(outcome.code).send({ error: outcome.message })
            }

            const detail = await getCatalogPurchaseDetail({ dealerId, poId })
            if (!detail) {
              return reply
                .code(500)
                .send({ error: 'Payment recorded but PO could not be re-loaded.' })
            }

            request.log.info(
              {
                dealerId,
                poId,
                payAmount: fromCents(payAmountCents),
                orderPaymentTypeId,
                markFullyPaid,
                unpayableBalanceCheck:
                  outcome.checkCents !== null ? fromCents(outcome.checkCents) : null,
                financialStatus: outcome.financialStatusName,
                by: user.email,
              },
              '[catalog/purchases] payment recorded',
            )

            return reply.send(
              CatalogPurchasePaymentResponseSchema.parse({
                detail,
                recorded: {
                  paymentDollars: fromCents(payAmountCents),
                  orderPaymentTypeId,
                  unpayableBalanceCheckDollars:
                    outcome.checkCents !== null ? fromCents(outcome.checkCents) : null,
                  financialStatusName: outcome.financialStatusName,
                  owedAfterDollars: fromCents(outcome.owedAfterCents),
                },
              }),
            )
          } finally {
            await client.query(`select pg_advisory_unlock(hashtext($1), hashtext($2))`, [
              lockKeyA,
              lockKeyB,
            ])
          }
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'payment failed'
        request.log.error({ dealerId, poId, err: message }, '[catalog/purchases] payment failed')
        return reply.code(502).send({ error: message })
      }
    },
  )

  // GET /api/catalog/purchases/:poId/items/:lineId?dealerId=...
  server.get<{
    Params: { poId: string; lineId: string }
    Querystring: { dealerId?: string }
  }>('/api/catalog/purchases/:poId/items/:lineId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const dealerIdRaw = request.query.dealerId
    const dealerId = dealerIdRaw ? Number(dealerIdRaw) : NaN
    if (!Number.isFinite(dealerId)) {
      return reply.code(400).send({ error: 'dealerId query param required' })
    }
    const result = await getCatalogPurchaseLineDetail({
      dealerId,
      poId: request.params.poId,
      lineId: request.params.lineId,
    })
    if (!result) return reply.code(404).send({ error: 'Purchase line not found' })
    return reply.send(CatalogPurchaseLineDetailResponseSchema.parse(result))
  })
}
