import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  LowInventoryResponseSchema,
  type HeliosPendingPurchaseSiteDealer,
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

  useRegisterCatalogSidebarSubtree()

  return <LowInventorySitePage key={site?.siteKey ?? siteKey ?? 'missing'} site={site} />
}

function LowInventorySitePage({ site }: { site: HeliosPendingPurchaseSiteDealer | null }) {
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
      onRetry={site === null ? undefined : () => setReloadKey((current) => current + 1)}
    />
  )
}
