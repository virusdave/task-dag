import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  WAREHOUSE_LOCATION_PREFIXES,
  WarehouseLocationAssignResponseSchema,
  WarehouseLocationsStateResponseSchema,
  isValidWarehouseLocationCode,
  type WarehouseLocationAssignResponse,
  type WarehouseLocationsStateResponse,
  type WarehousePackage,
  type WarehouseLocationPrefix,
  type WarehouseScanCandidate,
} from '../../../shared/contracts/index.js'
import { buildAppPath } from '../../app/paths.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'
import { LiveBarcodeScanner } from './LiveBarcodeScanner.js'

type Mode = 'assign' | 'audit'

const SPLIT_OPTIONS = ['', 'a', 'b', 'c', 'd', 'e', 'f'] as const

/* -------------------------------------------------------------------------- */
/*  Page shell + mode tabs                                                      */
/* -------------------------------------------------------------------------- */

export function WarehouseLocationsPage() {
  useRegisterCatalogSidebarSubtree()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode: Mode = searchParams.get('mode') === 'audit' ? 'audit' : 'assign'

  const setMode = (next: Mode) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'assign') params.delete('mode')
    else params.set('mode', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <section className="catalog-maintenance-page wh-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>Warehouse Locations</h2>
          <p className="subtle-copy">
            Midtown packing. Walk the floor category → column → row, scan the package living in each
            location, and Helios stamps that location onto the package's internal tracking code.
          </p>
        </div>
      </div>

      <div className="wh-tabs" role="tablist" aria-label="Warehouse locations mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'assign'}
          className={`ghost-button wh-tab${mode === 'assign' ? ' is-active' : ''}`}
          onClick={() => setMode('assign')}
        >
          Assign (shelf run)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'audit'}
          className={`ghost-button wh-tab${mode === 'audit' ? ' is-active' : ''}`}
          onClick={() => setMode('audit')}
        >
          Audit / backfill
        </button>
      </div>

      {mode === 'assign' ? <AssignMode /> : <AuditMode />}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Assign helpers                                                              */
/* -------------------------------------------------------------------------- */

interface AssignBody {
  locationCode: string
  source: 'shelf-scan' | 'audit'
  scannedCode?: string
  inventoryItemId?: string
  allowReassign?: boolean
}

type AssignOutcome =
  | { ok: true; data: WarehouseLocationAssignResponse }
  | { ok: false; error: string }

async function postAssign(body: AssignBody): Promise<AssignOutcome> {
  try {
    const response = await fetch(buildAppPath('/api/warehouse-locations/assign'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const error = await readError(response)
      return { ok: false, error }
    }
    const data = WarehouseLocationAssignResponseSchema.parse(await response.json())
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (typeof payload.error === 'string' && payload.error.length > 0) return payload.error
  } catch {
    /* fall through */
  }
  return `${response.status} ${response.statusText}`
}

function buildCode(
  prefix: WarehouseLocationPrefix | null,
  column: string,
  row: number,
  split: string,
): string | null {
  if (!prefix) return null
  if (!/^[A-Z]$/.test(column)) return null
  if (!Number.isInteger(row) || row < 1) return null
  const code = `${prefix}-${column}-${row}${split ? `-${split}` : ''}`
  return isValidWarehouseLocationCode(code) ? code : null
}

function metrcSuffix(tag: string | null): string {
  if (!tag) return '—'
  const cleaned = tag.replace(/\s+/g, '')
  return cleaned.length <= 6 ? cleaned : `…${cleaned.slice(-6)}`
}

function packageLabel(p: WarehousePackage | WarehouseScanCandidate): string {
  return p.productName ?? `Item #${p.inventoryItemId}`
}

/* -------------------------------------------------------------------------- */
/*  Location picker (shared by assign + audit)                                  */
/* -------------------------------------------------------------------------- */

interface LocationPickerProps {
  prefix: WarehouseLocationPrefix | null
  column: string
  row: number
  split: string
  onPrefix: (p: WarehouseLocationPrefix) => void
  onColumn: (c: string) => void
  onRow: (r: number) => void
  onSplit: (s: string) => void
}

function LocationPicker(props: LocationPickerProps) {
  const { prefix, column, row, split, onPrefix, onColumn, onRow, onSplit } = props
  const shiftColumn = (delta: number) => {
    const next = String.fromCharCode(
      Math.min(90, Math.max(65, column.charCodeAt(0) + delta)),
    )
    onColumn(next)
  }
  return (
    <div className="wh-picker">
      <div className="wh-picker-row">
        <span className="wh-picker-label">Category</span>
        <div className="inline-row wrap-row wh-chip-row">
          {WAREHOUSE_LOCATION_PREFIXES.map((entry) => (
            <button
              key={entry.prefix}
              type="button"
              className={`ghost-button wh-chip${prefix === entry.prefix ? ' is-active' : ''}`}
              onClick={() => onPrefix(entry.prefix)}
              title={entry.label}
            >
              {entry.prefix}
            </button>
          ))}
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Column</span>
        <div className="wh-stepper">
          <button type="button" className="ghost-button wh-step-btn" onClick={() => shiftColumn(-1)} aria-label="Previous column">
            −
          </button>
          <span className="wh-step-value">{column}</span>
          <button type="button" className="ghost-button wh-step-btn" onClick={() => shiftColumn(1)} aria-label="Next column">
            +
          </button>
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Row</span>
        <div className="wh-stepper">
          <button
            type="button"
            className="ghost-button wh-step-btn"
            onClick={() => onRow(Math.max(1, row - 1))}
            aria-label="Previous row"
          >
            −
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            className="wh-row-input"
            value={row}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10)
              onRow(Number.isInteger(next) && next >= 1 ? next : 1)
            }}
          />
          <button type="button" className="ghost-button wh-step-btn" onClick={() => onRow(row + 1)} aria-label="Next row">
            +
          </button>
        </div>
      </div>

      <div className="wh-picker-row">
        <span className="wh-picker-label">Bin split</span>
        <div className="inline-row wrap-row wh-chip-row">
          {SPLIT_OPTIONS.map((option) => (
            <button
              key={option || 'none'}
              type="button"
              className={`ghost-button wh-chip${split === option ? ' is-active' : ''}`}
              onClick={() => onSplit(option)}
            >
              {option === '' ? 'none' : option}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Assign mode                                                                 */
/* -------------------------------------------------------------------------- */

interface SessionEntry {
  locationCode: string
  label: string
  inventoryItemId: string
}

function AssignMode() {
  const [prefix, setPrefix] = useState<WarehouseLocationPrefix | null>(null)
  const [column, setColumn] = useState('A')
  const [row, setRow] = useState(1)
  const [split, setSplit] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'warn'; message: string } | null>(null)
  const [candidates, setCandidates] = useState<WarehouseScanCandidate[] | null>(null)
  const [reassign, setReassign] = useState<{
    candidate: WarehouseScanCandidate
    currentLocationCode: string
    pendingScannedCode?: string
    pendingInventoryItemId?: string
  } | null>(null)
  const [session, setSession] = useState<SessionEntry[]>([])
  // Guards against a double-submit from a rapid double-tap / Enter race, which
  // the disabled-on-`busy` buttons can't fully close (state lags the event).
  const inFlightRef = useRef(false)

  const currentCode = useMemo(() => buildCode(prefix, column, row, split), [prefix, column, row, split])

  const advanceRow = useCallback(() => {
    setRow((r) => r + 1)
    setSplit('')
  }, [])

  // Core submit. `extra` lets the disambiguation / confirm paths re-issue
  // the request with a resolved item id or override flags.
  const submit = useCallback(
    async (
      target: { scannedCode?: string; inventoryItemId?: string },
      flags?: { allowReassign?: boolean },
    ) => {
      if (!currentCode) {
        setBanner({ kind: 'err', message: 'Pick a category, column and row first.' })
        return
      }
      if (inFlightRef.current) return
      inFlightRef.current = true
      setBusy(true)
      setBanner({ kind: 'warn', message: 'Saving…' })
      let outcome: AssignOutcome
      try {
        outcome = await postAssign({
          locationCode: currentCode,
          source: 'shelf-scan',
          scannedCode: target.scannedCode,
          inventoryItemId: target.inventoryItemId,
          allowReassign: flags?.allowReassign,
        })
      } finally {
        inFlightRef.current = false
        setBusy(false)
      }
      if (!outcome.ok) {
        setBanner({ kind: 'err', message: outcome.error })
        return
      }
      const data = outcome.data
      switch (data.status) {
        case 'assigned': {
          const label = packageLabel(data.package)
          setBanner({ kind: 'ok', message: `✓ ${currentCode} → ${label}` })
          setSession((prev) => [
            { locationCode: currentCode, label, inventoryItemId: data.package.inventoryItemId },
            ...prev,
          ])
          setCandidates(null)
          setReassign(null)
          setManualCode('')
          advanceRow()
          return
        }
        case 'ambiguous':
          setCandidates(data.candidates)
          setBanner({
            kind: 'warn',
            message: `That barcode matches ${data.candidates.length} packages — pick the one in this location.`,
          })
          return
        case 'location-occupied': {
          const next = nextSplit(split)
          setBanner({
            kind: 'warn',
            message: `${currentCode} is already used by ${packageLabel(
              data.occupant,
            )}. Add a bin-split suffix to keep codes 1-to-1${next ? ` (try -${next})` : ''}.`,
          })
          if (next) setSplit(next)
          return
        }
        case 'already-assigned':
          setReassign({
            candidate: data.candidate,
            currentLocationCode: data.currentLocationCode,
            pendingScannedCode: target.scannedCode,
            pendingInventoryItemId: target.inventoryItemId,
          })
          setBanner({
            kind: 'warn',
            message: `That package is already located at ${data.currentLocationCode}.`,
          })
          return
      }
    },
    [advanceRow, currentCode, split],
  )

  const handleDetected = useCallback(
    (value: string) => {
      setScannerOpen(false)
      void submit({ scannedCode: value })
    },
    [submit],
  )
  const handleCancel = useCallback(() => setScannerOpen(false), [])

  const nextCodeLabel = currentCode ?? 'set location'

  return (
    <div className="wh-assign">
      <LocationPicker
        prefix={prefix}
        column={column}
        row={row}
        split={split}
        onPrefix={setPrefix}
        onColumn={setColumn}
        onRow={setRow}
        onSplit={setSplit}
      />

      <div className="wh-current" aria-live="polite">
        <span className="wh-current-label">Current location</span>
        <span className="wh-current-code">{currentCode ?? '—'}</span>
      </div>

      {banner ? (
        <div className={`catalog-maintenance-toast catalog-maintenance-toast-${banner.kind === 'err' ? 'err' : 'ok'} wh-banner wh-banner--${banner.kind}`}>
          <span>{banner.message}</span>
          <button type="button" className="ghost-button" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="wh-scan-actions">
        <button
          type="button"
          className="primary-button wh-scan-btn"
          disabled={!currentCode || busy}
          onClick={() => setScannerOpen(true)}
        >
          📷 Scan package → {nextCodeLabel}
        </button>
        <form
          className="wh-manual"
          onSubmit={(event) => {
            event.preventDefault()
            const value = manualCode.trim()
            if (value.length > 0) void submit({ scannedCode: value })
          }}
        >
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            className="wh-manual-input"
            placeholder="…or type / hardware-scan a barcode"
            value={manualCode}
            onChange={(event) => setManualCode(event.target.value)}
            disabled={!currentCode || busy}
          />
          <button type="submit" className="ghost-button" disabled={!currentCode || busy || manualCode.trim().length === 0}>
            Assign
          </button>
        </form>
      </div>

      {session.length > 0 ? (
        <div className="wh-session">
          <div className="wh-session-head">
            <strong>Assigned this session</strong>
            <Pill tone="muted">{String(session.length)}</Pill>
          </div>
          <ul className="wh-session-list">
            {session.map((entry, index) => (
              <li key={`${entry.inventoryItemId}:${index}`}>
                <code className="wh-session-code">{entry.locationCode}</code>
                <span className="subtle-copy">{entry.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <LiveBarcodeScanner open={scannerOpen} onDetected={handleDetected} onCancel={handleCancel} />

      {candidates ? (
        <DisambiguationModal
          candidates={candidates}
          locationCode={currentCode ?? ''}
          busy={busy}
          onPick={(itemId) => void submit({ inventoryItemId: itemId })}
          onCancel={() => {
            setCandidates(null)
            setBanner(null)
          }}
        />
      ) : null}

      {reassign ? (
        <ConfirmReassignModal
          info={reassign}
          locationCode={currentCode ?? ''}
          busy={busy}
          onConfirm={() =>
            void submit(
              {
                scannedCode: reassign.pendingScannedCode,
                inventoryItemId: reassign.pendingInventoryItemId,
              },
              { allowReassign: true },
            )
          }
          onCancel={() => {
            setReassign(null)
            setBanner(null)
          }}
        />
      ) : null}
    </div>
  )
}

function nextSplit(current: string): string | null {
  if (current === '') return 'a'
  if (current.length === 1 && current >= 'a' && current < 'z') {
    return String.fromCharCode(current.charCodeAt(0) + 1)
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*  Audit mode                                                                  */
/* -------------------------------------------------------------------------- */

function AuditMode() {
  const navigate = useNavigate()
  const [state, setState] = useState<WarehouseLocationsStateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null)

  const fetchState = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(buildAppPath('/api/warehouse-locations/state'), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (response.status === 401) {
        navigate('/login')
        return
      }
      if (!response.ok) {
        setError(await readError(response))
        return
      }
      setState(WarehouseLocationsStateResponseSchema.parse(await response.json()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => {
    void fetchState()
  }, [fetchState])

  const removePackage = useCallback((inventoryItemId: string) => {
    setState((prev) =>
      prev
        ? { ...prev, auditPackages: prev.auditPackages.filter((p) => p.inventoryItemId !== inventoryItemId) }
        : prev,
    )
  }, [])

  return (
    <div className="wh-audit">
      <div className="inline-row wrap-row catalog-maintenance-meta">
        {state?.meta.snapshotObservedAt ? (
          <Pill tone="muted">{`snapshot ${formatRelativeTime(state.meta.snapshotObservedAt)}`}</Pill>
        ) : null}
        {state ? (
          <Pill tone={state.auditPackages.length === 0 ? 'muted' : 'warning'}>
            {`${state.auditPackages.length} to locate`}
          </Pill>
        ) : null}
        {state ? <Pill tone="muted">{`${state.occupied.length} located`}</Pill> : null}
        <button type="button" className="ghost-button" disabled={loading} onClick={() => void fetchState()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {toast ? (
        <div className={`catalog-maintenance-toast catalog-maintenance-toast-${toast.kind}`}>
          <span>{toast.message}</span>
          <button type="button" className="ghost-button" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {error ? <div className="catalog-maintenance-toast catalog-maintenance-toast-err">{error}</div> : null}

      {loading && !state ? <p className="subtle-copy">Loading…</p> : null}

      {state && state.auditPackages.length === 0 && !loading ? (
        <p className="subtle-copy">Every in-stock FOR-SALE Midtown package has a warehouse location. 🎉</p>
      ) : null}

      <ul className="catalog-maintenance-list wh-audit-list">
        {state?.auditPackages.map((pkg) => (
          <li key={pkg.inventoryItemId}>
            <AuditCard
              pkg={pkg}
              onAssigned={(message) => {
                setToast({ kind: 'ok', message })
                removePackage(pkg.inventoryItemId)
              }}
              onError={(message) => setToast({ kind: 'err', message })}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

interface AuditCardProps {
  pkg: WarehousePackage
  onAssigned: (message: string) => void
  onError: (message: string) => void
}

function AuditCard({ pkg, onAssigned, onError }: AuditCardProps) {
  const [open, setOpen] = useState(false)
  const [prefix, setPrefix] = useState<WarehouseLocationPrefix | null>(null)
  const [column, setColumn] = useState('A')
  const [row, setRow] = useState(1)
  const [split, setSplit] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReassign, setConfirmReassign] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const code = useMemo(() => buildCode(prefix, column, row, split), [prefix, column, row, split])

  const doAssign = useCallback(
    async (allowReassign?: boolean) => {
      if (!code) return
      if (inFlightRef.current) return
      inFlightRef.current = true
      setBusy(true)
      let outcome: AssignOutcome
      try {
        outcome = await postAssign({
          locationCode: code,
          source: 'audit',
          inventoryItemId: pkg.inventoryItemId,
          allowReassign,
        })
      } finally {
        inFlightRef.current = false
        setBusy(false)
      }
      if (!outcome.ok) {
        onError(outcome.error)
        return
      }
      const data = outcome.data
      switch (data.status) {
        case 'assigned':
          onAssigned(`✓ ${code} → ${packageLabel(pkg)}`)
          return
        case 'location-occupied': {
          const next = nextSplit(split)
          onError(
            `${code} is already used by ${packageLabel(data.occupant)}. Add a bin-split suffix${
              next ? ` (try -${next})` : ''
            }.`,
          )
          if (next) setSplit(next)
          return
        }
        case 'already-assigned':
          setConfirmReassign(data.currentLocationCode)
          return
        case 'ambiguous':
          // Not reachable for an inventoryItemId-based assign, but handle
          // defensively rather than silently dropping the response.
          onError('Unexpected ambiguous result for a direct package assignment.')
          return
      }
    },
    [code, onAssigned, onError, pkg, split],
  )

  return (
    <article className="catalog-maintenance-card wh-audit-card">
      <div className="wh-audit-card-meta">
        <strong>{packageLabel(pkg)}</strong>
        <span className="subtle-copy">
          METRC {metrcSuffix(pkg.metrcTag)}
          {pkg.availableQty !== null ? ` · qty ${pkg.availableQty}` : ''}
          {pkg.stockLocation ? ` · ${pkg.stockLocation}` : ''}
        </span>
        {pkg.internalTrackCode ? (
          <span className="subtle-copy">current code: <code>{pkg.internalTrackCode}</code></span>
        ) : (
          <span className="subtle-copy">no internal code</span>
        )}
      </div>

      {!open ? (
        <button type="button" className="primary-button" onClick={() => setOpen(true)}>
          Assign location
        </button>
      ) : (
        <div className="wh-audit-assign">
          <LocationPicker
            prefix={prefix}
            column={column}
            row={row}
            split={split}
            onPrefix={setPrefix}
            onColumn={setColumn}
            onRow={setRow}
            onSplit={setSplit}
          />
          <div className="wh-current">
            <span className="wh-current-label">Location</span>
            <span className="wh-current-code">{code ?? '—'}</span>
          </div>
          <div className="inline-row wrap-row" style={{ gap: '0.5rem' }}>
            <button type="button" className="primary-button" disabled={!code || busy} onClick={() => void doAssign()}>
              {busy ? 'Saving…' : `Assign ${code ?? ''}`}
            </button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmReassign ? (
        <ConfirmReassignModal
          info={{
            candidate: {
              inventoryItemId: pkg.inventoryItemId,
              productName: pkg.productName,
              metrcTag: pkg.metrcTag,
              availableQty: pkg.availableQty,
              stockLocation: pkg.stockLocation,
              currentInternalTrackCode: confirmReassign,
            },
            currentLocationCode: confirmReassign,
          }}
          locationCode={code ?? ''}
          busy={busy}
          onConfirm={() => {
            setConfirmReassign(null)
            void doAssign(true)
          }}
          onCancel={() => setConfirmReassign(null)}
        />
      ) : null}
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/*  Modals                                                                      */
/* -------------------------------------------------------------------------- */

function DisambiguationModal(props: {
  candidates: WarehouseScanCandidate[]
  locationCode: string
  busy: boolean
  onPick: (inventoryItemId: string) => void
  onCancel: () => void
}) {
  const { candidates, locationCode, busy, onPick, onCancel } = props
  return (
    <div className="wh-modal-overlay" role="dialog" aria-modal="true">
      <div className="wh-modal">
        <h3>Which package is at {locationCode}?</h3>
        <p className="subtle-copy">That barcode matches more than one in-stock package. Pick the one physically in this location.</p>
        <ul className="wh-candidate-list">
          {candidates.map((candidate) => (
            <li key={candidate.inventoryItemId}>
              <button
                type="button"
                className="ghost-button wh-candidate-btn"
                disabled={busy}
                onClick={() => onPick(candidate.inventoryItemId)}
              >
                <strong>{packageLabel(candidate)}</strong>
                <span className="subtle-copy">
                  METRC {metrcSuffix(candidate.metrcTag)}
                  {candidate.availableQty !== null ? ` · qty ${candidate.availableQty}` : ''}
                  {candidate.stockLocation ? ` · ${candidate.stockLocation}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="wh-modal-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmReassignModal(props: {
  info: { candidate: WarehouseScanCandidate; currentLocationCode: string }
  locationCode: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { info, locationCode, busy, onConfirm, onCancel } = props
  return (
    <div className="wh-modal-overlay" role="dialog" aria-modal="true">
      <div className="wh-modal">
        <h3>Move this package's location?</h3>
        <p>
          <strong>{packageLabel(info.candidate)}</strong> is already located at{' '}
          <code>{info.currentLocationCode}</code>. Overwrite it with <code>{locationCode}</code>?
        </p>
        <div className="wh-modal-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Saving…' : `Move to ${locationCode}`}
          </button>
        </div>
      </div>
    </div>
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
