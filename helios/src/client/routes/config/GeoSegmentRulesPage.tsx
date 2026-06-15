// Control-plane page for the geographic (scan-location-based) segment
// assignment engine. Lists every row in `geo_segment_rules`, shows each
// rule's live application tallies, and lets an editor create, edit,
// enable/disable, and delete rules.
//
// A rule adds customers whose GEOCODED ID home address falls within
// `radiusFeet` of a geofence centre, who satisfy `trigger` on/after
// `since`, to a Sweed marketing segment. The live on-scan engine
// (config.workers.geo_segment_rule_eval) evaluates the `first_scan`
// trigger with no deploy needed: enabling a rule here takes effect on
// the next qualifying scan. `first_purchase` is schema-only today
// (backfill-only), surfaced with a clear badge so an operator is not
// misled into thinking it fires live.
//
// Server enforces role >= editor on every write; this page additionally
// hides the write controls from viewers.

import { useMemo, useState, type CSSProperties } from 'react'
import { useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  GeoSegmentRuleDeleteResponseSchema,
  GeoSegmentRuleMutationResponseSchema,
  GeoSegmentRulesListResponseSchema,
  type GeoSegmentRuleCreateBody,
  type GeoSegmentRuleRecord,
  type GeoSegmentRulesListResponse,
  type GeoSegmentRuleUpdateBody,
  type GeoSegmentSiteOption,
  type GeoSegmentTrigger,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyFloorToDay, nyIsoDate, nyLongDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function geoSegmentRulesLoader(): Promise<GeoSegmentRulesListResponse> {
  return loadJson('/api/geo-segment-rules', GeoSegmentRulesListResponseSchema)
}

const TRIGGER_OPTIONS: { value: GeoSegmentTrigger; label: string }[] = [
  { value: 'first_scan', label: 'First scan (live on-scan)' },
  { value: 'first_purchase', label: 'First purchase (backfill only)' },
]

const TRIGGER_LABELS: Record<GeoSegmentTrigger, string> = {
  first_scan: 'First scan',
  first_purchase: 'First purchase',
}

// Local form-layout styles. The global `.filter-row input/select` rule
// forces `min-width:180px; flex:1 1 180px`, which misbehaves when the
// control is nested inside a column-flex label. We instead flex the
// LABEL and let the control fill it, so the form collapses to a clean
// single column on a narrow (~375px) phone with no horizontal scroll.
const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: '1 1 220px',
  minWidth: 0,
}
const compactFieldStyle: CSSProperties = { ...fieldStyle, flex: '1 1 150px' }
const controlStyle: CSSProperties = { width: '100%', minWidth: 0, flex: '0 0 auto' }

function sweedSegmentUrl(segmentId: number): string {
  return `https://prime.sweedpos.com/marketing/segments/segment/${segmentId}`
}

// A success notice scoped to where the action happened: the create card
// ('create'), a specific rule card (the rule id), or page-global. Keeps
// the result and a Sweed link at the user's fingertip instead of a
// detached banner at the top of a long page.
interface ActionNotice {
  readonly scope: 'create' | 'global' | number
  readonly message: string
  readonly segmentId?: number
}

function ActionNoticeStrip({ notice }: { notice: ActionNotice }) {
  return (
    <div className="runtime-status-strip" style={{ marginTop: 12 }}>
      <div className="runtime-status-item">
        <Pill tone="success">saved</Pill>
        <span className="subtle-copy">
          {notice.message}
          {notice.segmentId ? (
            <>
              {' '}
              <a href={sweedSegmentUrl(notice.segmentId)} target="_blank" rel="noreferrer">
                Open Sweed segment {notice.segmentId}
              </a>
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}

// Convert a yyyy-mm-dd calendar date to the UTC ISO instant of NY-local
// midnight on that date (DST-correct via nyFloorToDay). Returns null for
// an empty input so "no lower bound" round-trips cleanly.
function nyDateToIso(dateStr: string): string | null {
  if (dateStr.trim() === '') return null
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  // Noon UTC of the chosen date is always the same NY calendar day, so
  // flooring it to the NY day yields that date's NY midnight.
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0)
  return new Date(nyFloorToDay(noonUtc)).toISOString()
}

// Form state is all strings (raw input values); parsed on submit.
interface RuleFormState {
  siteSlug: string
  dealerId: string
  segmentId: string
  centerLat: string
  centerLng: string
  radiusFeet: string
  trigger: GeoSegmentTrigger
  reactivationDays: string
  sinceDate: string
  note: string
  enabled: boolean
}

function emptyFormState(siteOptions: GeoSegmentSiteOption[]): RuleFormState {
  const first = siteOptions[0]
  return {
    siteSlug: first?.siteSlug ?? '',
    dealerId: '',
    segmentId: '',
    centerLat: first ? String(first.lat) : '',
    centerLng: first ? String(first.lng) : '',
    radiusFeet: '3750',
    trigger: 'first_scan',
    reactivationDays: '365',
    sinceDate: '',
    note: '',
    enabled: true,
  }
}

function formStateFromRule(rule: GeoSegmentRuleRecord): RuleFormState {
  return {
    siteSlug: rule.siteSlug,
    dealerId: String(rule.dealerId),
    segmentId: String(rule.segmentId),
    centerLat: String(rule.centerLat),
    centerLng: String(rule.centerLng),
    radiusFeet: String(rule.radiusFeet),
    trigger: rule.trigger,
    reactivationDays: String(rule.reactivationDays),
    sinceDate: rule.since ? nyIsoDate(Date.parse(rule.since)) : '',
    note: rule.note ?? '',
    enabled: rule.enabled,
  }
}

class FormError extends Error {}

// Parse a create body from the form. Throws FormError with a friendly
// message on the first invalid field; the server + zod remain the
// authoritative validators.
function parseCreateBody(state: RuleFormState): GeoSegmentRuleCreateBody {
  const num = (raw: string, label: string): number => {
    const value = Number(raw)
    if (raw.trim() === '' || Number.isNaN(value)) {
      throw new FormError(`${label} must be a number.`)
    }
    return value
  }
  const intPositive = (raw: string, label: string): number => {
    const value = num(raw, label)
    if (!Number.isInteger(value) || value <= 0) {
      throw new FormError(`${label} must be a positive whole number.`)
    }
    return value
  }
  if (state.siteSlug.trim() === '') {
    throw new FormError('Site is required.')
  }
  return {
    siteSlug: state.siteSlug.trim(),
    dealerId: intPositive(state.dealerId, 'Dealer id'),
    segmentId: intPositive(state.segmentId, 'Segment id'),
    centerLat: num(state.centerLat, 'Center latitude'),
    centerLng: num(state.centerLng, 'Center longitude'),
    radiusFeet: num(state.radiusFeet, 'Radius (feet)'),
    trigger: state.trigger,
    reactivationDays: intPositive(state.reactivationDays, 'Reactivation window (days)'),
    since: nyDateToIso(state.sinceDate),
    enabled: state.enabled,
    note: state.note.trim() === '' ? undefined : state.note.trim(),
  }
}

interface RuleFormProps {
  readonly siteOptions: GeoSegmentSiteOption[]
  readonly state: RuleFormState
  readonly onChange: (next: RuleFormState) => void
  readonly busy: boolean
  // When true, the identity/target fields (site, dealer, segment,
  // trigger) are locked. They are immutable after creation because the
  // application ledger is keyed by rule id; retargeting needs a new rule.
  readonly identityLocked?: boolean
}

function RuleFormFields({ siteOptions, state, onChange, busy, identityLocked = false }: RuleFormProps) {
  const patch = (partial: Partial<RuleFormState>) => onChange({ ...state, ...partial })
  const selectedSite = siteOptions.find((s) => s.siteSlug === state.siteSlug)
  return (
    <>
      <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
        <label style={fieldStyle}>
          <span className="subtle-copy">Site</span>
          <select
            value={state.siteSlug}
            disabled={busy || identityLocked}
            style={controlStyle}
            onChange={(event) => {
              const slug = event.target.value
              const pin = siteOptions.find((s) => s.siteSlug === slug)
              patch(
                pin
                  ? { siteSlug: slug, centerLat: String(pin.lat), centerLng: String(pin.lng) }
                  : { siteSlug: slug },
              )
            }}
          >
            {siteOptions.map((s) => (
              <option key={s.siteSlug} value={s.siteSlug}>
                {s.label} ({s.siteSlug})
              </option>
            ))}
            {selectedSite ? null : (
              <option value={state.siteSlug}>{state.siteSlug || '(unknown)'}</option>
            )}
          </select>
        </label>

        <label style={fieldStyle}>
          <span className="subtle-copy">Trigger</span>
          <select
            value={state.trigger}
            disabled={busy || identityLocked}
            style={controlStyle}
            onChange={(event) => patch({ trigger: event.target.value as GeoSegmentTrigger })}
          >
            {TRIGGER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>

        <label style={compactFieldStyle}>
          <span className="subtle-copy">Dealer id</span>
          <input
            type="number"
            value={state.dealerId}
            disabled={busy || identityLocked}
            placeholder="210249"
            onChange={(event) => patch({ dealerId: event.target.value })}
            style={controlStyle}
          />
        </label>

        <label style={compactFieldStyle}>
          <span className="subtle-copy">Segment id</span>
          <input
            type="number"
            value={state.segmentId}
            disabled={busy || identityLocked}
            placeholder="10282"
            onChange={(event) => patch({ segmentId: event.target.value })}
            style={controlStyle}
          />
        </label>
      </div>

      <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
        <label style={compactFieldStyle}>
          <span className="subtle-copy">Center latitude</span>
          <input
            type="number"
            value={state.centerLat}
            disabled={busy}
            step="any"
            onChange={(event) => patch({ centerLat: event.target.value })}
            style={controlStyle}
          />
        </label>

        <label style={compactFieldStyle}>
          <span className="subtle-copy">Center longitude</span>
          <input
            type="number"
            value={state.centerLng}
            disabled={busy}
            step="any"
            onChange={(event) => patch({ centerLng: event.target.value })}
            style={controlStyle}
          />
        </label>

        {selectedSite ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            title={`Set center to the ${selectedSite.label} store pin.`}
            style={{ flex: '1 1 150px', minWidth: 0 }}
            onClick={() =>
              patch({ centerLat: String(selectedSite.lat), centerLng: String(selectedSite.lng) })
            }
          >
            Use store center
          </button>
        ) : null}

        <label style={compactFieldStyle}>
          <span className="subtle-copy">Radius (feet)</span>
          <input
            type="number"
            value={state.radiusFeet}
            disabled={busy}
            step="any"
            onChange={(event) => patch({ radiusFeet: event.target.value })}
            style={controlStyle}
          />
        </label>
      </div>

      <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
        <label style={compactFieldStyle}>
          <span className="subtle-copy">Reactivation window (days)</span>
          <input
            type="number"
            value={state.reactivationDays}
            disabled={busy || state.trigger !== 'first_scan'}
            onChange={(event) => patch({ reactivationDays: event.target.value })}
            style={controlStyle}
          />
          <span className="subtle-copy" style={{ fontSize: '0.8em' }}>
            First scan only: ignore prior scans older than this.
          </span>
        </label>

        <label style={compactFieldStyle}>
          <span className="subtle-copy">On or after (NY date)</span>
          <input
            type="date"
            value={state.sinceDate}
            disabled={busy}
            onChange={(event) => patch({ sinceDate: event.target.value })}
            style={controlStyle}
          />
          <span className="subtle-copy" style={{ fontSize: '0.8em' }}>
            Lower bound on the event. Blank means no bound.
          </span>
        </label>

        <label
          style={{ ...compactFieldStyle, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={busy}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span className="subtle-copy">Enabled (live)</span>
        </label>
      </div>

      <div className="filter-row" style={{ marginTop: 8 }}>
        <label style={{ ...fieldStyle, flex: '1 1 100%' }}>
          <span className="subtle-copy">Note (optional)</span>
          <input
            type="text"
            value={state.note}
            disabled={busy}
            placeholder="What this rule is for"
            onChange={(event) => patch({ note: event.target.value })}
            style={controlStyle}
          />
        </label>
      </div>
    </>
  )
}

export function GeoSegmentRulesPage() {
  useRegisterConfigSidebarSubtree()
  const initialData = useLoaderData() as GeoSegmentRulesListResponse
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const revalidator = useRevalidator()

  const canEdit = useMemo(() => {
    const role = session?.user?.role
    return role === 'editor' || role === 'approver' || role === 'admin'
  }, [session])

  const { rules, siteOptions } = initialData

  const [createState, setCreateState] = useState<RuleFormState>(() => emptyFormState(siteOptions))
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editState, setEditState] = useState<RuleFormState | null>(null)
  const [busyRuleId, setBusyRuleId] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<ActionNotice | null>(null)

  async function handleCreate(): Promise<void> {
    setErrorMessage(null)
    setNotice(null)
    let body: GeoSegmentRuleCreateBody
    try {
      body = parseCreateBody(createState)
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Invalid rule.')
      return
    }
    setCreating(true)
    try {
      const result = await mutateJson(
        '/api/geo-segment-rules',
        GeoSegmentRuleMutationResponseSchema,
        { method: 'POST', body: JSON.stringify(body) },
      )
      setNotice({
        scope: 'create',
        message: `Created rule #${result.rule.id} for ${result.rule.siteSlug}.`,
        segmentId: result.rule.segmentId,
      })
      setCreateState(emptyFormState(siteOptions))
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to create rule.')
    } finally {
      setCreating(false)
    }
  }

  async function patchRule(
    ruleId: number,
    patch: GeoSegmentRuleUpdateBody,
    successNotice: ActionNotice,
  ): Promise<boolean> {
    setBusyRuleId(ruleId)
    setErrorMessage(null)
    setNotice(null)
    try {
      await mutateJson(`/api/geo-segment-rules/${ruleId}`, GeoSegmentRuleMutationResponseSchema, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setNotice(successNotice)
      revalidator.revalidate()
      return true
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to update rule.')
      return false
    } finally {
      setBusyRuleId(null)
    }
  }

  async function handleSaveEdit(rule: GeoSegmentRuleRecord): Promise<void> {
    if (!editState) return
    let createBody: GeoSegmentRuleCreateBody
    try {
      createBody = parseCreateBody(editState)
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Invalid rule.')
      return
    }
    // Identity / target fields (site, dealer, segment, trigger) are
    // immutable server-side, so PATCH only the editable tuning fields.
    const body: GeoSegmentRuleUpdateBody = {
      centerLat: createBody.centerLat,
      centerLng: createBody.centerLng,
      radiusFeet: createBody.radiusFeet,
      reactivationDays: createBody.reactivationDays,
      since: createBody.since ?? null,
      enabled: createBody.enabled,
      note: createBody.note ?? null,
    }
    const ok = await patchRule(rule.id, body, {
      scope: rule.id,
      message: `Saved rule #${rule.id}.`,
      segmentId: rule.segmentId,
    })
    if (ok) {
      setEditingId(null)
      setEditState(null)
    }
  }

  async function handleDelete(rule: GeoSegmentRuleRecord): Promise<void> {
    const ok = window.confirm(
      `Delete rule #${rule.id} (${rule.siteSlug} / ${rule.trigger} -> segment ${rule.segmentId})?\n\n` +
        'This also removes its application history, so a future re-create could re-add customers ' +
        'who were already added. Disable instead if you only want to stop it firing.',
    )
    if (!ok) return
    setBusyRuleId(rule.id)
    setErrorMessage(null)
    setNotice(null)
    try {
      await mutateJson(`/api/geo-segment-rules/${rule.id}`, GeoSegmentRuleDeleteResponseSchema, {
        method: 'DELETE',
      })
      setNotice({ scope: 'global', message: `Deleted rule #${rule.id}.` })
      if (editingId === rule.id) {
        setEditingId(null)
        setEditState(null)
      }
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to delete rule.')
    } finally {
      setBusyRuleId(null)
    }
  }

  const enabledCount = rules.filter((r) => r.enabled).length

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Marketing</p>
          <h2>Geo segment rules</h2>
          <p className="subtle-copy">
            Assign customers to a Sweed marketing segment based on where their scanned ID home
            address geocodes. A rule adds a customer when their geocoded address is within the
            radius of the geofence center and the qualifying event happens on or after the optional
            start date. The live on-scan engine evaluates first scan rules with no deploy, so
            enabling a rule here takes effect on the next qualifying scan. First purchase rules are
            schema only today and run during a one-off backfill, not live.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone="muted">{`${rules.length} rule${rules.length === 1 ? '' : 's'}`}</Pill>
          <Pill tone="success">{`${enabledCount} enabled`}</Pill>
        </div>
      </div>

      {errorMessage ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy">{errorMessage}</span>
          </div>
        </div>
      ) : null}

      {notice?.scope === 'global' ? <ActionNoticeStrip notice={notice} /> : null}

      {canEdit ? (
        <article className="history-card" style={{ marginTop: 16 }}>
          <header>
            <strong>Create a rule</strong>
          </header>
          <p className="subtle-copy" style={{ marginTop: 4 }}>
            Pick a site to auto-fill the geofence center from the store pin, then set the target
            Sweed segment and radius. The dealer id is the Sweed dealer that owns the segment.
          </p>
          <RuleFormFields
            siteOptions={siteOptions}
            state={createState}
            onChange={setCreateState}
            busy={creating}
          />
          <div className="filter-row" style={{ marginTop: 12 }}>
            <button
              className="ghost-button"
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create rule'}
            </button>
          </div>
          {notice?.scope === 'create' ? <ActionNoticeStrip notice={notice} /> : null}
        </article>
      ) : (
        <p className="subtle-copy" style={{ marginTop: 16 }}>
          You have read-only access. Ask an editor to create or change rules.
        </p>
      )}

      <div className="stacked-list" style={{ marginTop: 16 }}>
        {rules.length === 0 ? (
          <article className="history-card">
            <p className="subtle-copy">No rules yet.</p>
          </article>
        ) : (
          rules.map((rule) => {
            const busy = busyRuleId === rule.id
            const isEditing = editingId === rule.id
            const totalApplications =
              rule.stats.applied +
              rule.stats.alreadyMember +
              rule.stats.failed +
              rule.stats.pending
            const deletable = !rule.enabled && totalApplications === 0
            const deleteHint = rule.enabled
              ? 'Disable the rule before deleting it.'
              : totalApplications > 0
                ? 'This rule has application history; leave it disabled instead of deleting.'
                : 'Delete this rule.'
            return (
              <article className="history-card" key={rule.id}>
                <div className="history-card-topline wrap-row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>
                      {rule.siteLabel ?? rule.siteSlug} ({rule.siteSlug}) · {TRIGGER_LABELS[rule.trigger]}
                    </strong>
                    <p className="subtle-copy" style={{ marginTop: 2 }}>
                      rule #{rule.id} · segment{' '}
                      <a href={sweedSegmentUrl(rule.segmentId)} target="_blank" rel="noreferrer">
                        {rule.segmentId}
                      </a>{' '}
                      · dealer {rule.dealerId} · {Math.round(rule.radiusFeet)} ft around{' '}
                      {rule.centerLat.toFixed(5)}, {rule.centerLng.toFixed(5)}
                      {rule.trigger === 'first_scan'
                        ? ` · reactivation ${rule.reactivationDays}d`
                        : ''}
                      {rule.since ? ` · on/after ${nyIsoDate(Date.parse(rule.since))}` : ''}
                    </p>
                    {rule.note ? (
                      <p className="subtle-copy" style={{ marginTop: 2 }}>{rule.note}</p>
                    ) : null}
                    <p className="subtle-copy" style={{ marginTop: 2 }}>
                      updated {nyLongDateTime(Date.parse(rule.updatedAt))} NY
                    </p>
                  </div>
                  <div className="inline-row wrap-row">
                    <Pill tone={rule.enabled ? 'success' : 'muted'}>
                      {rule.enabled ? 'enabled' : 'disabled'}
                    </Pill>
                    <Pill tone={rule.triggerLive ? 'success' : 'warning'}>
                      {rule.triggerLive ? 'live on-scan' : 'backfill only'}
                    </Pill>
                  </div>
                </div>

                <div className="inline-row wrap-row" style={{ marginTop: 10, gap: 8 }}>
                  <Pill tone="success">{`${rule.stats.applied} added`}</Pill>
                  <Pill tone="muted">{`${rule.stats.alreadyMember} already member`}</Pill>
                  {rule.stats.pending > 0 ? (
                    <Pill tone="warning">{`${rule.stats.pending} pending`}</Pill>
                  ) : null}
                  {rule.stats.failed > 0 ? (
                    <Pill tone="danger">{`${rule.stats.failed} failed`}</Pill>
                  ) : null}
                </div>

                {canEdit ? (
                  <div className="filter-row wrap-row" style={{ marginTop: 12, gap: 8 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busy}
                        onChange={(event) =>
                          void patchRule(rule.id, { enabled: event.target.checked }, {
                            scope: rule.id,
                            message: `${event.target.checked ? 'Enabled' : 'Disabled'} rule #${rule.id}.`,
                            segmentId: rule.segmentId,
                          })
                        }
                      />
                      <span className="subtle-copy">Enabled</span>
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={busy}
                      onClick={() => {
                        if (isEditing) {
                          setEditingId(null)
                          setEditState(null)
                        } else {
                          setEditingId(rule.id)
                          setEditState(formStateFromRule(rule))
                        }
                      }}
                    >
                      {isEditing ? 'Close' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={busy || !deletable}
                      title={deleteHint}
                      onClick={() => void handleDelete(rule)}
                    >
                      Delete
                    </button>
                    {busy ? <span className="subtle-copy">saving…</span> : null}
                  </div>
                ) : null}

                {typeof notice?.scope === 'number' && notice.scope === rule.id ? (
                  <ActionNoticeStrip notice={notice} />
                ) : null}

                {isEditing && editState ? (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid var(--control-border, #d8d8d8)',
                    }}
                  >
                    <p className="subtle-copy" style={{ marginBottom: 4 }}>
                      Site, dealer, segment, and trigger are fixed for an existing rule. To retarget,
                      create a new rule.
                    </p>
                    <RuleFormFields
                      siteOptions={siteOptions}
                      state={editState}
                      onChange={setEditState}
                      busy={busy}
                      identityLocked
                    />
                    <div className="filter-row" style={{ marginTop: 12, gap: 8 }}>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={busy}
                        onClick={() => void handleSaveEdit(rule)}
                      >
                        {busy ? 'Saving…' : 'Save changes'}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(null)
                          setEditState(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
