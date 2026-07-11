import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouteLoaderData } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  LowInventoryAuditListResponseSchema,
  LowInventoryCountResponseSchema,
  LowInventoryResponseSchema,
  LowInventoryTransferConfigResponseSchema,
  LowInventoryTransferResponseSchema,
  type HeliosPendingPurchaseSiteDealer,
  type LowInventoryAuditResult,
  type LowInventoryCountRequest,
  type LowInventoryTransferConfigBody,
  type LowInventoryTransferConfigResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { LowInventoryView, type LowInventoryViewState } from './LowInventoryView.js'

function siteForKey(siteKey: string | undefined): HeliosPendingPurchaseSiteDealer | null {
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((site) => site.siteKey === siteKey) ?? null
}

export function LowInventoryPage() {
  const { siteKey } = useParams<{ siteKey: string }>()
  const site = useMemo(() => siteForKey(siteKey), [siteKey])
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined

  useRegisterCatalogSidebarSubtree()

  return <LowInventorySitePage
    key={site?.siteKey ?? siteKey ?? 'missing'}
    site={site}
    canEdit={session?.permissions.canEditProposals === true}
    isAdmin={session?.user?.role === 'admin'}
  />
}

function LowInventorySitePage(props: {
  canEdit: boolean
  isAdmin: boolean
  site: HeliosPendingPurchaseSiteDealer | null
}) {
  const { canEdit, isAdmin, site } = props
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<LowInventoryViewState>(() => site === null
    ? { kind: 'error', message: 'That store is not available. Choose Bronx or Midtown from the navigation.' }
    : { kind: 'loading' })
  const [audits, setAudits] = useState<LowInventoryAuditResult[]>([])
  const [transferConfig, setTransferConfig] = useState<LowInventoryTransferConfigResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [mutationMessage, setMutationMessage] = useState<string | null>(null)

  useEffect(() => {
    if (site === null) return
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void Promise.all([
      loadJson(`/api/low-inventory?dealerId=${encodeURIComponent(String(site.dealerId))}`, LowInventoryResponseSchema, { signal: controller.signal }),
      loadJson(`/api/low-inventory/audits?dealerId=${encodeURIComponent(String(site.dealerId))}&limit=100`, LowInventoryAuditListResponseSchema, { signal: controller.signal }),
      loadJson(`/api/low-inventory/transfer-config?dealerId=${encodeURIComponent(String(site.dealerId))}`, LowInventoryTransferConfigResponseSchema, { signal: controller.signal }),
    ]).then(([response, auditResponse, config]) => {
      if (response.site.dealerId !== site.dealerId || response.site.siteKey !== site.siteKey) {
        setState({ kind: 'error', message: 'The inventory response was for a different store. Reload before continuing.' })
        return
      }
      setAudits(auditResponse.items)
      setTransferConfig(config)
      setState({ kind: 'ready', response })
    }, (error: unknown) => {
      if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Low-inventory data could not be loaded.' })
    })
    return () => controller.abort()
  }, [reloadKey, site])

  async function runMutation(run: () => Promise<string>): Promise<void> {
    setBusy(true)
    setMutationMessage(null)
    try {
      setMutationMessage(await run())
      setReloadKey((current) => current + 1)
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : 'The request failed safely. Reload and try again.')
      throw error
    } finally {
      setBusy(false)
    }
  }

  return <LowInventoryView
    audits={audits}
    busy={busy}
    canEdit={canEdit}
    isAdmin={isAdmin}
    mutationMessage={mutationMessage}
    siteLabel={site?.siteLabel ?? 'Low inventory'}
    state={state}
    transferConfig={transferConfig}
    onRetry={site === null ? undefined : () => setReloadKey((current) => current + 1)}
    onRecordCount={site === null ? undefined : (body: LowInventoryCountRequest) => runMutation(async () => {
      const result = await mutateJson('/api/low-inventory/counts', LowInventoryCountResponseSchema, { method: 'POST', body: JSON.stringify(body) })
      return result.notificationStatus === 'failed'
        ? `Count recorded as audit #${result.auditId}, but the operator notification failed.`
        : `Count recorded as audit #${result.auditId}.`
    })}
    onSaveTransferConfig={site === null ? undefined : (body: LowInventoryTransferConfigBody) => runMutation(async () => {
      const result = await mutateJson('/api/low-inventory/transfer-config', LowInventoryTransferConfigResponseSchema, { method: 'PUT', body: JSON.stringify(body) })
      return result.transferEnabled ? `Transfers enabled to ${result.destinationName}.` : 'Package transfers disabled for this site.'
    })}
    onTransfer={site === null ? undefined : (auditId: number, config: LowInventoryTransferConfigResponse) => runMutation(async () => {
      const result = await mutateJson('/api/low-inventory/transfers', LowInventoryTransferResponseSchema, { method: 'POST', body: JSON.stringify({ dealerId: site.dealerId, countAuditId: auditId, confirmedConfigUpdatedAt: config.updatedAt, confirmedDestinationName: config.destinationName }) })
      return result.notificationStatus === 'failed'
        ? `Moved ${result.movedQty} unit(s) out of FOR SALE (audit #${result.transferAuditId}), but the operator notification failed.`
        : `Moved ${result.movedQty} unit(s) out of FOR SALE. Audit #${result.transferAuditId}.`
    })}
  />
}
