import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  PurchaseLifecycleReleaseTargetsResponseSchema,
  PurchaseLifecycleStatusResponseSchema,
  type CatalogPurchaseHeader,
  type PurchaseLifecyclePath,
  type PurchaseLifecycleReleaseTarget,
  type PurchaseLifecycleState,
  type PurchaseLifecycleStatusResponse,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import {
  marketGateLabel,
  onFloorStockBadge,
  priceUnapprovedLabel,
  priceUnverifiedLabel,
  quarantineGateLabel,
  releaseButtonLabel,
  releaseGateLabel,
  repriceButtonLabel,
} from './purchaseLifecyclePanelLabels.js'

// ---------------------------------------------------------------------------
// Pricing-safety lifecycle panel (automation#54, L1).
//
// Lives on the Catalog → Purchase detail page. Loads lazily on expand so
// it never errors on page load before migration 095 is applied, and so a
// normal sell-through view stays fast. Drives the per-PO gates:
//   quarantine → market refresh → reprice → release (deep-links the
//   existing pricing review UI for the actual approval). L2 adds the
//   bulk quarantine repair + gated reverse/release to a FOR SALE room.
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<PurchaseLifecycleState, string> = {
  not_started: 'Not started',
  awaiting_receive_to_quarantine: 'Awaiting receive → quarantine',
  quarantined: 'Quarantined',
  market_refresh_pending: 'Market refresh pending',
  market_ready: 'Market ready',
  pricing_pending: 'Pricing pending',
  awaiting_price_approval: 'Awaiting price approval',
  price_apply_pending: 'Price apply pending',
  priced_verified: 'Priced & verified',
  release_in_progress: 'Release in progress',
  released: 'Released',
  blocked: 'Blocked',
}

function stateTone(state: PurchaseLifecycleState): 'muted' | 'success' | 'warning' | 'danger' {
  if (state === 'priced_verified' || state === 'released') return 'success'
  if (state === 'blocked') return 'danger'
  return 'warning'
}

interface PanelProps {
  purchase: CatalogPurchaseHeader
}

export function PurchaseInventoryLifecyclePanel(props: PanelProps): JSX.Element {
  const { purchase } = props
  const [status, setStatus] = useState<PurchaseLifecycleStatusResponse | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [path, setPath] = useState<PurchaseLifecyclePath>('quarantine')

  const base = `/api/catalog/purchases/${encodeURIComponent(purchase.poId)}/lifecycle`

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const next = await loadJson(
        `${base}?dealerId=${encodeURIComponent(purchase.dealerId)}`,
        PurchaseLifecycleStatusResponseSchema,
      )
      setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lifecycle.')
    } finally {
      setLoaded(true)
    }
  }, [base, purchase.dealerId])

  async function act(label: string, suffix: string, body: Record<string, unknown>): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      const next = await mutateJson(`${base}/${suffix}`, PurchaseLifecycleStatusResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed.`)
      // Re-sync so the version/state reflect reality after a conflict.
      void refresh()
    } finally {
      setBusy(null)
    }
  }

  function onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void {
    if (event.currentTarget.open && !loaded) {
      void refresh()
    }
  }

  return (
    <details className="purchase-lifecycle-panel" onToggle={onToggle}>
      <summary>Pricing-safety lifecycle</summary>
      <div className="purchase-lifecycle-body">
        {!loaded ? <p className="purchase-muted">Loading…</p> : null}
        {error ? <p className="purchase-danger">{error}</p> : null}
        {loaded && status?.migrationPending ? (
          <p className="purchase-muted">
            Not available yet — database migration 095 has not been applied. Ask an operator to
            run it, then reload.
          </p>
        ) : null}
        {loaded && status && !status.migrationPending ? (
          <LifecycleBody
            status={status}
            path={path}
            setPath={setPath}
            busy={busy}
            act={act}
            base={base}
            poId={purchase.poId}
            dealerId={purchase.dealerId}
          />
        ) : null}
      </div>
    </details>
  )
}

function LifecycleBody(props: {
  status: PurchaseLifecycleStatusResponse
  path: PurchaseLifecyclePath
  setPath: (p: PurchaseLifecyclePath) => void
  busy: string | null
  act: (label: string, suffix: string, body: Record<string, unknown>) => Promise<void>
  base: string
  poId: string
  dealerId: number
}): JSX.Element {
  const { status, path, setPath, busy, act, base, dealerId } = props
  const run = status.run
  const disabled = busy !== null

  if (!run) {
    const canStart = status.expectedProductIds.length > 0
    return (
      <div>
        <p>
          This PO maps to <strong>{status.expectedProductIds.length}</strong> product(s). Start a
          pricing-safety run to make sure they are priced against live market data before they
          sell.
        </p>
        <label className="purchase-lifecycle-pathpick">
          <span>Path</span>
          <select
            value={path}
            onChange={(e) => setPath(e.target.value as PurchaseLifecyclePath)}
            disabled={disabled}
          >
            <option value="quarantine">Quarantine first (full lifecycle)</option>
            <option value="reprice_in_place">Reprice in place (skip quarantine)</option>
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || !canStart}
          onClick={() => act('Start', 'start', { dealerId, path })}
        >
          {busy === 'Start' ? 'Starting…' : 'Start lifecycle'}
        </button>
        {!canStart ? (
          <p className="purchase-muted">No product-mapped, positive-qty lines to price.</p>
        ) : null}
      </div>
    )
  }

  const v = run.version
  const summary = status.gateSummary

  return (
    <div>
      <div className="purchase-status-stack">
        <Pill tone={stateTone(run.state)}>{STATE_LABELS[run.state]}</Pill>
        <Pill tone="muted">{run.path === 'quarantine' ? 'Quarantine path' : 'Reprice in place'}</Pill>
        {run.blockedReason ? <Pill tone="danger">{run.blockedReason}</Pill> : null}
      </div>

      {summary
        ? (() => {
            const quarantine = quarantineGateLabel(run, summary)
            const release = releaseGateLabel(run, summary)
            const onFloor = onFloorStockBadge(summary)
            return (
              <>
                <dl className="purchase-lifecycle-gates">
                  <dt>Lots still sellable</dt>
                  <dd className={quarantine.danger ? 'purchase-danger' : undefined}>
                    {quarantine.text}
                  </dd>
                  <dt>Products awaiting market data</dt>
                  <dd>{marketGateLabel(run, summary)}</dd>
                  <dt>Products not yet price-approved</dt>
                  <dd>{priceUnapprovedLabel(run, summary)}</dd>
                  <dt>Products not yet price-verified</dt>
                  <dd>{priceUnverifiedLabel(run, summary)}</dd>
                  <dt>Lots not yet released</dt>
                  <dd className={release.danger ? 'purchase-danger' : undefined}>{release.text}</dd>
                </dl>
                {onFloor ? (
                  <p className="purchase-muted purchase-lifecycle-onfloor-badge">⚠ {onFloor}</p>
                ) : null}
              </>
            )
          })()
        : null}

      <div className="purchase-lifecycle-actions">
        {run.path === 'quarantine' && run.state === 'awaiting_receive_to_quarantine' ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => act('Verify quarantine', 'verify-quarantine', { dealerId, expectedVersion: v })}
          >
            {busy === 'Verify quarantine' ? 'Verifying…' : 'Verify quarantine'}
          </button>
        ) : null}

        {/* Bulk repair: pull the PO's expected lots off the floor into the
            inspection room, for a delivery received straight into FOR SALE. */}
        {run.path === 'quarantine' && run.state === 'awaiting_receive_to_quarantine' ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => act('Repair quarantine', 'repair-quarantine', { dealerId, expectedVersion: v })}
          >
            {busy === 'Repair quarantine' ? 'Repairing…' : 'Bulk move to quarantine'}
          </button>
        ) : null}

        {(run.state === 'quarantined' ||
          run.state === 'market_refresh_pending' ||
          run.state === 'market_ready') ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => act('Pull market data', 'market-refresh', { dealerId, expectedVersion: v })}
          >
            {busy === 'Pull market data' ? 'Enqueuing…' : 'Pull market data'}
          </button>
        ) : null}

        {(run.state === 'market_refresh_pending' ||
          run.state === 'market_ready' ||
          run.state === 'pricing_pending' ||
          run.state === 'awaiting_price_approval' ||
          run.state === 'price_apply_pending' ||
          run.state === 'priced_verified') ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => act('Reprice', 'reprice', { dealerId, expectedVersion: v })}
          >
            {busy === 'Reprice' ? 'Working…' : repriceButtonLabel(run.state)}
          </button>
        ) : null}

        {run.pricingBatchId !== null ? (
          <Link className="purchase-lifecycle-link" to={`/pricing/runs/${run.pricingBatchId}`}>
            Open pricing review →
          </Link>
        ) : null}
      </div>

      {status.releaseMigrationPending ? (
        <p className="purchase-muted">
          Release controls need database migration 096, which has not been applied yet. Ask an
          operator to run it, then reload.
        </p>
      ) : run.path === 'quarantine' ? (
        <ReleaseControls
          status={status}
          base={base}
          dealerId={dealerId}
          busy={busy}
          act={act}
        />
      ) : null}

      {run.path === 'reprice_in_place' && run.state === 'priced_verified' ? (
        <p className="purchase-muted">
          Reprice-in-place path: prices are verified against live Sweed prices and the lots stay
          where they are. No release/move-back step.
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// L2 release controls. Only shown on the quarantine path once migration
// 096 is live. Loads the live FOR SALE rooms lazily and preselects the
// per-site default ("FOR SALE - Sales Floor", decision 6); the chosen id
// is re-resolved live against Sweed at release time, never trusted blindly.
// ---------------------------------------------------------------------------

function ReleaseControls(props: {
  status: PurchaseLifecycleStatusResponse
  base: string
  dealerId: number
  busy: string | null
  act: (label: string, suffix: string, body: Record<string, unknown>) => Promise<void>
}): JSX.Element | null {
  const { status, base, dealerId, busy, act } = props
  const run = status.run
  const [targets, setTargets] = useState<PurchaseLifecycleReleaseTarget[] | null>(null)
  const [targetId, setTargetId] = useState<number | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const disabled = busy !== null

  const loadTargets = useCallback(async () => {
    setTargetsError(null)
    try {
      const res = await loadJson(
        `${base}/release-targets?dealerId=${encodeURIComponent(dealerId)}`,
        PurchaseLifecycleReleaseTargetsResponseSchema,
      )
      setTargets(res.targets)
      const preferred = res.targets.find((t) => t.isDefault) ?? res.targets[0] ?? null
      setTargetId(preferred ? preferred.locationId : null)
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : 'Failed to load FOR SALE rooms.')
      setTargets([])
    }
  }, [base, dealerId])

  if (!run) return null

  const canStartRelease = run.state === 'priced_verified'
  // Continue picks up the un-released lots: while an attempt is mid-flight
  // (lease may have expired after a crash) OR after a partial failure. It
  // matches the service's `continuable` set.
  const canContinue =
    run.state === 'release_in_progress' ||
    (run.state === 'blocked' && run.blockedReason === 'release_partial_failure')
  const isReleaseBlock =
    run.state === 'blocked' &&
    (run.blockedReason === 'release_preflight_failed' ||
      run.blockedReason === 'release_partial_failure' ||
      run.blockedReason === 'release_price_drift' ||
      run.blockedReason === 'release_rollback_failed')
  const canRollback = run.state === 'released' || isReleaseBlock
  const showReleaseFlow = canStartRelease || canContinue || isReleaseBlock || run.state === 'released'

  if (!showReleaseFlow) return null

  return (
    <div className="purchase-lifecycle-release">
      {run.releaseTargetLocationName ? (
        <p className="purchase-muted">
          Release target: <strong>{run.releaseTargetLocationName}</strong>
          {run.releasedAt ? ` · released ${run.releasedAt}` : null}
        </p>
      ) : null}
      {run.releaseLastError ? (
        <p className="purchase-danger">Last release error: {run.releaseLastError}</p>
      ) : null}

      {canStartRelease ? (
        targets === null ? (
          <button type="button" disabled={disabled} onClick={() => void loadTargets()}>
            Choose FOR SALE room…
          </button>
        ) : (
          <div className="purchase-lifecycle-release-pick">
            <label className="purchase-lifecycle-pathpick">
              <span>Release to</span>
              <select
                value={targetId ?? ''}
                onChange={(e) => setTargetId(Number(e.target.value))}
                disabled={disabled || targets.length === 0}
              >
                {targets.map((t) => (
                  <option key={t.locationId} value={t.locationId}>
                    {t.locationName}
                    {t.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || targetId === null}
              onClick={() =>
                act('Release', 'release', {
                  dealerId,
                  expectedVersion: run.version,
                  targetLocationId: targetId,
                })
              }
            >
              {busy === 'Release' ? 'Releasing…' : releaseButtonLabel(run.state)}
            </button>
          </div>
        )
      ) : null}
      {targetsError ? <p className="purchase-danger">{targetsError}</p> : null}

      {canContinue ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            act('Continue release', 'continue-release', { dealerId, expectedVersion: run.version })
          }
        >
          {busy === 'Continue release' ? 'Continuing…' : 'Continue release'}
        </button>
      ) : null}

      {canRollback ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            act('Roll back release', 'rollback-release', { dealerId, expectedVersion: run.version })
          }
        >
          {busy === 'Roll back release' ? 'Rolling back…' : 'Roll back release (move to quarantine)'}
        </button>
      ) : null}

      {run.state === 'released' ? (
        <p className="purchase-muted">
          Every expected lot is released to the chosen FOR SALE room and confirmed sellable at the
          approved price.
        </p>
      ) : null}
    </div>
  )
}
