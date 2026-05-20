import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { Pill } from '../../components/Pill.js'
import {
  buildMaintenanceIndexPath,
  buildMaintenanceSitePath,
  computePerSiteBrandFilters,
  useRegisterCatalogSidebarSubtree,
} from './catalogSidebarSubtree.js'
import { useMaintenanceSurvey } from './CatalogMaintenancePage.js'

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
  const { state, feedback, setFeedback, fetchSurvey, repairBusy, handleRepairCache } = useMaintenanceSurvey()

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
          <p className="eyebrow">Catalog Module</p>
          <h2>Images &amp; Barcodes</h2>
          <p className="subtle-copy">
            Pick the site you're physically at. Each site is a separate page so your phone only
            loads the SKUs you can actually photograph from where you're standing.
          </p>
        </div>
        <div className="inline-row wrap-row catalog-maintenance-meta">
          {state.survey?.meta.generatedAt ? (
            <Pill tone="muted">scanned {formatRelativeTime(state.survey.meta.generatedAt)}</Pill>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            disabled={state.refreshing}
            onClick={() => void fetchSurvey(true)}
          >
            {state.refreshing ? 'Refreshing…' : 'Refresh survey'}
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

      {state.survey?.fatal ? (
        <div className="catalog-maintenance-fatal-banner catalog-maintenance-toast catalog-maintenance-toast-err">
          <div>
            <strong>⚠ {state.survey.fatal.title}</strong>
            <p style={{ margin: '0.25rem 0' }}>{state.survey.fatal.message}</p>
            {state.survey.fatal.canRepair ? (
              <button
                type="button"
                className="primary-button"
                disabled={repairBusy}
                onClick={() => void handleRepairCache()}
              >
                {repairBusy ? 'Enqueuing fix-cache jobs…' : '🛠 Fix cache (enqueue high-priority workers)'}
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
              No sites returned by the survey. Try Refresh, or Fix cache if the fatal banner is showing.
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
                      {site.brands.length} brand{site.brands.length === 1 ? '' : 's'} with candidates
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Pill tone={site.totalIssueCount === 0 ? 'muted' : 'warning'}>
                      {site.totalIssueCount} issue{site.totalIssueCount === 1 ? '' : 's'}
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
