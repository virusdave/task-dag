import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouteLoaderData } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  LowInventoryResponseSchema,
  type HeliosPendingPurchaseSiteDealer,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { LowInventoryView, type LowInventoryViewState } from './LowInventoryView.js'

function siteForKey(siteKey: string | undefined): HeliosPendingPurchaseSiteDealer | null {
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((site) => site.siteKey === siteKey) ?? null
}

export function LowInventoryPage() {
  const { siteKey } = useParams<{ siteKey: string }>()
  const site = useMemo(() => siteForKey(siteKey), [siteKey])
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const countMigrationPending = session?.pendingMigrations.some(
    (migration) => migration.migrationId === '103_low_inventory_physical_counts',
  ) ?? true
  const isEditor = session?.permissions.canEditProposals === true
  const canCaptureCounts = isEditor && !countMigrationPending

  useRegisterCatalogSidebarSubtree()

  return (
    <LowInventorySitePage
      key={site?.siteKey ?? siteKey ?? 'missing'}
      site={site}
      canCaptureCounts={canCaptureCounts}
      countMigrationPending={isEditor && countMigrationPending}
    />
  )
}

function LowInventorySitePage(props: {
  site: HeliosPendingPurchaseSiteDealer | null
  canCaptureCounts: boolean
  countMigrationPending: boolean
}) {
  const { canCaptureCounts, countMigrationPending, site } = props
  const [cannabisOnly, setCannabisOnly] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<LowInventoryViewState>(() => site === null
    ? { kind: 'error', message: 'That store is not available. Choose Bronx or Midtown from the navigation.' }
    : { kind: 'loading' })

  useEffect(() => {
    if (site === null) return

    const controller = new AbortController()
    setState({ kind: 'loading' })
    void loadJson(
      `/api/low-inventory?dealerId=${encodeURIComponent(String(site.dealerId))}`,
      LowInventoryResponseSchema,
      { signal: controller.signal },
    ).then(
      (response) => {
        if (response.site.dealerId !== site.dealerId || response.site.siteKey !== site.siteKey) {
          setState({ kind: 'error', message: 'The inventory response was for a different store. Reload before continuing.' })
          return
        }
        setState({ kind: 'ready', response })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Low-inventory data could not be loaded.',
          })
        }
      },
    )
    return () => controller.abort()
  }, [reloadKey, site])

  return (
    <LowInventoryView
      cannabisOnly={cannabisOnly}
      onCannabisOnlyChange={setCannabisOnly}
      siteLabel={site?.siteLabel ?? 'Low inventory'}
      state={state}
      canCaptureCounts={canCaptureCounts}
      countMigrationPending={countMigrationPending}
      onRetry={site === null ? undefined : () => setReloadKey((current) => current + 1)}
    />
  )
}
