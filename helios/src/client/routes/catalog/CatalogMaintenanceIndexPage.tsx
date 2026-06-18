import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { Pill } from '../../components/Pill.js'
import {
  buildMaintenanceIndexPath,
  buildMaintenanceSitePath,
  computePerSiteBrandFilters,
  useRegisterCatalogSidebarSubtree,
} from './catalogSidebarSubtree.js'
import { CacheRepairProgressPanel, useMaintenanceSurvey } from './CatalogMaintenancePage.js'

/**
 * Images & Barcodes — site index landing page.
 *
 * The operator on the floor opens this on their phone, picks the site
 * they're physically standing in, and drills in. The per-site page is
 * a separate route that only fetches/renders that site's data — this
 * landing intentionally never lists individual SKU cards.
 *
 * Page-level "Refresh survey" and "Fix cache" controls live HERE so
 * the per-site page can stay focused on the worklist.
 */
export function CatalogMaintenanceIndexPage() {
  const { state, feedback, setFeedback, fetchSurvey, repairBusy, handleRepairCache, repairJobs, clearRepairJobs } =
    useMaintenanceSurvey()

  const sites = useMemo(
    () => (state.survey ? computePerSiteBrandFilters(state.survey) : []),
    [state.survey],
  )

  useRegisterCatalogSidebarSubtree({
    imagesAndBarcodes: {
      indexPath: buildMaintenanceIndexPath(),
      sites,
      activeSiteKey: null,
      activeBrand: null,
    },
  })

  return (
    <section className="catalog-maintenance-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog</p>
          <h2>Photos &amp; Barcodes</h2>
          <p className="subtle-copy">
            Pick the store you're at. Each store is a separate page so your phone only loads the
            items you can actually photograph from where you're standing.
          </p>
        </div>
        <div className="inline-row wrap-row catalog-maintenance-meta">
          {state.survey?.meta.generatedAt ? (
            <Pill tone="muted">Last checked {formatRelativeTime(state.survey.meta.generatedAt)}</Pill>
          ) : null}
          <button
            type="button"
            className="primary-button"
            disabled={repairBusy}
            onClick={() => void handleRepairCache()}
          >
            {repairBusy ? 'Checking…' : 'Check for new or updated stock'}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={state.refreshing}
            onClick={() => void fetchSurvey(true)}
          >
            {state.refreshing ? 'Reloading…' : 'Reload list'}
          </button>
        </div>
      </div>

      {feedback ? (
        <div className={`catalog-maintenance-toast catalog-maintenance-toast-${feedback.kind}`}>
          <span>{feedback.message}</span>
          <button type="button" className="ghost-button" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {state.error ? (
        <div className="catalog-maintenance-toast catalog-maintenance-toast-err">{state.error}</div>
      ) : null}

      {repairJobs ? (
        <CacheRepairProgressPanel
          jobs={repairJobs}
          onDismiss={clearRepairJobs}
          onRescan={() => void fetchSurvey(true)}
        />
      ) : null}

      {state.survey?.fatal ? (
        <div className="catalog-maintenance-toast" role="status" style={{ alignItems: 'flex-start' }}>
          <div>
            <strong>{state.survey.fatal.title}</strong>
            <p style={{ margin: '0.25rem 0' }}>{state.survey.fatal.message}</p>
            {state.survey.fatal.canRepair ? (
              <button
                type="button"
                className="primary-button"
                disabled={repairBusy}
                onClick={() => void handleRepairCache()}
              >
                {repairBusy ? 'Checking…' : 'Check for new or updated stock'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {state.loading && !state.survey ? <p className="subtle-copy">Loading…</p> : null}

      {state.survey ? (
        <ul
          className="catalog-maintenance-list"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: '0.75rem',
          }}
        >
          {sites.length === 0 ? (
            <li className="subtle-copy">
              No stores to show yet. Tap "Check for new or updated stock".
            </li>
          ) : (
            sites.map((site) => (
              <li key={site.siteKey}>
                <Link
                  to={buildMaintenanceSitePath(site.siteKey)}
                  className="catalog-maintenance-card"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.9rem 1rem',
                    textDecoration: 'none',
                    color: 'inherit',
                    minHeight: 64,
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <strong style={{ fontSize: '1.05rem' }}>{site.siteLabel}</strong>
                    <span className="subtle-copy">
                      {site.totalIssueCount === 0
                        ? site.pendingImportCount > 0
                          ? 'New items still loading'
                          : 'All set'
                        : `${site.brands.length} brand${site.brands.length === 1 ? '' : 's'} need attention`}
                      {site.totalIssueCount > 0 && site.pendingImportCount > 0
                        ? ` · ${site.pendingImportCount} still loading`
                        : ''}
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {site.pendingImportCount > 0 ? (
                      <Pill tone="muted">{site.pendingImportCount} still loading</Pill>
                    ) : null}
                    <Pill tone={site.totalIssueCount === 0 ? 'muted' : 'warning'}>
                      {site.totalIssueCount} to fix
                    </Pill>
                    <span aria-hidden="true">›</span>
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  )
}

function formatRelativeTime(iso: string): string {
  const generated = Date.parse(iso)
  if (!Number.isFinite(generated)) return iso
  const seconds = Math.max(0, Math.floor((Date.now() - generated) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
