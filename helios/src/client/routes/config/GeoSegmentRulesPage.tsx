// Control-plane page for the geographic / behavioural auto-segmentation
// engine. Lists every rule in `geo_segment_rules`, shows each rule's live
// application tallies, and lets an editor compose, edit, enable/disable,
// and delete rules with a COMPOSABLE condition builder.
//
// A rule adds a customer to a Sweed marketing segment when ALL of its
// conditions (predicates) hold at scan time: a geofence around a point,
// a home-ZIP / home-state set, a scan-date window, a "first scan in ≥ N
// days" window, an age range, and/or a gender set. The live on-scan
// engine (config.workers.geo_segment_rule_eval) evaluates `first_scan`
// rules with no deploy — enabling a rule here takes effect on the next
// qualifying scan. `first_purchase` is schema-only (backfill) today and
// is badged as such. See
// docs/helios/customer-segmentation/GEO_SEGMENT_RULES_DESIGN.md.
//
// Server enforces role >= editor on every write; this page additionally
// hides the write controls from viewers. Identity/target fields (site,
// dealer, segment, trigger) are immutable once a rule exists because the
// application ledger is keyed by rule id; the builder locks them on edit.

import { useMemo, useState, type CSSProperties } from 'react'
import { useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  GeoSegmentRuleDeleteResponseSchema,
  GeoSegmentRuleMutationResponseSchema,
  GeoSegmentRulesListResponseSchema,
  type GeoGender,
  type GeoPredicate,
  type GeoPredicateAst,
  type GeoPredicateKind,
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

// Operator-facing labels for each scan-safe predicate kind.
const PREDICATE_LABELS: Record<GeoPredicateKind, string> = {
  geofence: 'Within radius of a point',
  zip5_in: 'Home ZIP is one of',
  us_state_in: 'Home state is one of',
  scan_time_window: 'Scan date window',
  first_scan_in_days: 'New / lapsed (no scan in ≥ N days)',
  age_range: 'Age range',
  gender_in: 'ID gender marker is one of',
}

const PREDICATE_ORDER: GeoPredicateKind[] = [
  'geofence',
  'zip5_in',
  'us_state_in',
  'scan_time_window',
  'first_scan_in_days',
  'age_range',
  'gender_in',
]

const GENDERS: GeoGender[] = ['M', 'F', 'X']
const GENDER_LABELS: Record<GeoGender, string> = { M: 'M marker', F: 'F marker', X: 'X marker' }

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

// yyyy-mm-dd (NY calendar) -> UTC ISO of NY-local midnight that day.
function nyDateToIso(dateStr: string): string | null {
  if (dateStr.trim() === '') return null
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return null
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0)
  return new Date(nyFloorToDay(noonUtc)).toISOString()
}

const isoToNyDate = (iso: string | undefined): string => (iso ? nyIsoDate(Date.parse(iso)) : '')

// ===========================================================================
// Predicate draft model — all inputs are raw strings, parsed on submit.
// A single draft object carries every kind's fields; only the active
// kind's fields are read when building the GeoPredicate.
// ===========================================================================

interface PredicateDraft {
  kind: GeoPredicateKind
  centerLat: string
  centerLng: string
  radiusFeet: string
  zips: string
  states: string
  sinceDate: string
  untilDate: string
  days: string
  minAge: string
  maxAge: string
  genders: Record<GeoGender, boolean>
}

function blankDraft(kind: GeoPredicateKind, site?: GeoSegmentSiteOption): PredicateDraft {
  return {
    kind,
    centerLat: site ? String(site.lat) : '',
    centerLng: site ? String(site.lng) : '',
    radiusFeet: '3750',
    zips: '',
    states: '',
    sinceDate: '',
    untilDate: '',
    days: '365',
    minAge: '',
    maxAge: '',
    genders: { M: false, F: false, X: false },
  }
}

function draftFromPredicate(p: GeoPredicate, site?: GeoSegmentSiteOption): PredicateDraft {
  const d = blankDraft(p.kind, site)
  switch (p.kind) {
    case 'geofence':
      return { ...d, centerLat: String(p.centerLat), centerLng: String(p.centerLng), radiusFeet: String(p.radiusFeet) }
    case 'zip5_in':
      return { ...d, zips: p.zip5.join(', ') }
    case 'us_state_in':
      return { ...d, states: p.states.join(', ') }
    case 'scan_time_window':
      return { ...d, sinceDate: isoToNyDate(p.since), untilDate: isoToNyDate(p.until) }
    case 'first_scan_in_days':
      return { ...d, days: String(p.days) }
    case 'age_range':
      return { ...d, minAge: p.minAge === undefined ? '' : String(p.minAge), maxAge: p.maxAge === undefined ? '' : String(p.maxAge) }
    case 'gender_in':
      return { ...d, genders: { M: p.genders.includes('M'), F: p.genders.includes('F'), X: p.genders.includes('X') } }
  }
}

class FormError extends Error {}

function intPositive(raw: string, label: string): number {
  const value = Number(raw)
  if (raw.trim() === '' || Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
    throw new FormError(`${label} must be a positive whole number.`)
  }
  return value
}
function intInRange(raw: string, label: string, lo: number, hi: number): number {
  const value = Number(raw)
  if (raw.trim() === '' || Number.isNaN(value) || !Number.isInteger(value) || value < lo || value > hi) {
    throw new FormError(`${label} must be a whole number between ${lo} and ${hi}.`)
  }
  return value
}
function finite(raw: string, label: string): number {
  const value = Number(raw)
  if (raw.trim() === '' || Number.isNaN(value)) throw new FormError(`${label} must be a number.`)
  return value
}

// Build a validated GeoPredicate from one draft (friendly errors first;
// the server's zod is the authoritative validator).
function predicateFromDraft(d: PredicateDraft): GeoPredicate {
  switch (d.kind) {
    case 'geofence': {
      const radiusFeet = finite(d.radiusFeet, 'Radius (feet)')
      if (radiusFeet <= 0) throw new FormError('Radius (feet) must be positive.')
      return { kind: 'geofence', centerLat: finite(d.centerLat, 'Center latitude'), centerLng: finite(d.centerLng, 'Center longitude'), radiusFeet }
    }
    case 'zip5_in': {
      const zip5 = [...new Set(d.zips.split(/[\s,]+/).map((z) => z.trim()).filter((z) => z !== ''))]
      if (zip5.length === 0) throw new FormError('Enter at least one ZIP code.')
      for (const z of zip5) if (!/^\d{5}$/.test(z)) throw new FormError(`"${z}" is not a 5-digit ZIP.`)
      return { kind: 'zip5_in', zip5 }
    }
    case 'us_state_in': {
      const states = [...new Set(d.states.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter((s) => s !== ''))]
      if (states.length === 0) throw new FormError('Enter at least one 2-letter state.')
      for (const s of states) if (!/^[A-Z]{2}$/.test(s)) throw new FormError(`"${s}" is not a 2-letter state code.`)
      return { kind: 'us_state_in', states }
    }
    case 'scan_time_window': {
      const since = nyDateToIso(d.sinceDate) ?? undefined
      const until = nyDateToIso(d.untilDate) ?? undefined
      if (since === undefined && until === undefined) throw new FormError('Set an "on or after" and/or "before" date.')
      if (since !== undefined && until !== undefined && new Date(since) >= new Date(until)) {
        throw new FormError('"On or after" must be before "before".')
      }
      return { kind: 'scan_time_window', ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) }
    }
    case 'first_scan_in_days':
      return { kind: 'first_scan_in_days', days: intPositive(d.days, 'First-scan window (days)') }
    case 'age_range': {
      const hasMin = d.minAge.trim() !== ''
      const hasMax = d.maxAge.trim() !== ''
      if (!hasMin && !hasMax) throw new FormError('Set a min and/or max age.')
      const minAge = hasMin ? intInRange(d.minAge, 'Min age', 0, 130) : undefined
      const maxAge = hasMax ? intInRange(d.maxAge, 'Max age', 0, 130) : undefined
      if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) throw new FormError('Min age must be ≤ max age.')
      return { kind: 'age_range', ...(minAge !== undefined ? { minAge } : {}), ...(maxAge !== undefined ? { maxAge } : {}) }
    }
    case 'gender_in': {
      const genders = GENDERS.filter((g) => d.genders[g])
      if (genders.length === 0) throw new FormError('Pick at least one gender.')
      return { kind: 'gender_in', genders }
    }
  }
}

// One-line human summary of a predicate, for the live rule preview and
// the rule cards. NY dates for readability.
function describePredicate(p: GeoPredicate): string {
  switch (p.kind) {
    case 'geofence':
      return `within ${Math.round(p.radiusFeet)} ft of ${p.centerLat.toFixed(5)}, ${p.centerLng.toFixed(5)}`
    case 'zip5_in':
      return `home ZIP in ${p.zip5.join(', ')}`
    case 'us_state_in':
      return `home state in ${p.states.join(', ')}`
    case 'scan_time_window': {
      const parts: string[] = []
      if (p.since !== undefined) parts.push(`on/after ${isoToNyDate(p.since)}`)
      if (p.until !== undefined) parts.push(`before ${isoToNyDate(p.until)}`)
      return `scan ${parts.join(' & ')}`
    }
    case 'first_scan_in_days':
      return `no scan in prior ${p.days} days`
    case 'age_range': {
      if (p.minAge !== undefined && p.maxAge !== undefined) return `age ${p.minAge}–${p.maxAge}`
      if (p.minAge !== undefined) return `age ≥ ${p.minAge}`
      return `age ≤ ${p.maxAge}`
    }
    case 'gender_in':
      return `ID gender marker ${p.genders.join('/')}`
  }
}

// Build the AST from the drafts, surfacing the first invalid draft.
function astFromDrafts(drafts: PredicateDraft[]): GeoPredicateAst {
  return { version: 1, op: 'and', predicates: drafts.map(predicateFromDraft) }
}

// ===========================================================================
// Rule form state
// ===========================================================================

interface RuleFormState {
  siteSlug: string
  dealerId: string
  segmentId: string
  trigger: GeoSegmentTrigger
  note: string
  enabled: boolean
  predicates: PredicateDraft[]
}

function emptyFormState(siteOptions: GeoSegmentSiteOption[]): RuleFormState {
  const first = siteOptions[0]
  return {
    siteSlug: first?.siteSlug ?? '',
    dealerId: '',
    segmentId: '',
    trigger: 'first_scan',
    note: '',
    enabled: true,
    // Seed the common hyperlocal first-scan shape: a geofence on the
    // store pin + a 1-year first-scan window. The operator tunes/removes.
    predicates: [blankDraft('geofence', first), blankDraft('first_scan_in_days', first)],
  }
}

function formStateFromRule(rule: GeoSegmentRuleRecord, siteOptions: GeoSegmentSiteOption[]): RuleFormState {
  const site = siteOptions.find((s) => s.siteSlug === rule.siteSlug)
  return {
    siteSlug: rule.siteSlug,
    dealerId: String(rule.dealerId),
    segmentId: String(rule.segmentId),
    trigger: rule.trigger,
    note: rule.note ?? '',
    enabled: rule.enabled,
    predicates: rule.predicateJson.predicates.map((p) => draftFromPredicate(p, site)),
  }
}

function buildAst(state: RuleFormState): GeoPredicateAst {
  return astFromDrafts(state.predicates)
}

function parseCreateBody(state: RuleFormState): GeoSegmentRuleCreateBody {
  if (state.siteSlug.trim() === '') throw new FormError('Site is required.')
  const predicateJson = buildAst(state)
  if (state.enabled && predicateJson.predicates.length === 0) {
    throw new FormError('Add at least one condition before enabling the rule.')
  }
  return {
    siteSlug: state.siteSlug.trim(),
    dealerId: intPositive(state.dealerId, 'Dealer id'),
    segmentId: intPositive(state.segmentId, 'Segment id'),
    trigger: state.trigger,
    predicateJson,
    enabled: state.enabled,
    note: state.note.trim() === '' ? undefined : state.note.trim(),
  }
}

// ===========================================================================
// Predicate card editor
// ===========================================================================

function PredicateCard({
  draft,
  siteOptions,
  selectedSite,
  busy,
  onChange,
  onRemove,
}: {
  draft: PredicateDraft
  siteOptions: GeoSegmentSiteOption[]
  selectedSite?: GeoSegmentSiteOption
  busy: boolean
  onChange: (next: PredicateDraft) => void
  onRemove: () => void
}) {
  const patch = (partial: Partial<PredicateDraft>) => onChange({ ...draft, ...partial })
  let summary = ''
  try {
    summary = describePredicate(predicateFromDraft(draft))
  } catch (cause) {
    summary = cause instanceof Error ? `⚠ ${cause.message}` : '⚠ incomplete'
  }
  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--control-border, #d8d8d8)',
        background: 'var(--surface-2, rgba(0,0,0,0.02))',
      }}
    >
      <div className="inline-row wrap-row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: '0.9em' }}>{PREDICATE_LABELS[draft.kind]}</strong>
        <button type="button" className="ghost-button" disabled={busy} onClick={onRemove} title="Remove this condition" style={{ flex: '0 0 auto' }}>
          Remove
        </button>
      </div>

      {draft.kind === 'geofence' ? (
        <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Center latitude</span>
            <input type="number" step="any" value={draft.centerLat} disabled={busy} style={controlStyle} onChange={(e) => patch({ centerLat: e.target.value })} />
          </label>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Center longitude</span>
            <input type="number" step="any" value={draft.centerLng} disabled={busy} style={controlStyle} onChange={(e) => patch({ centerLng: e.target.value })} />
          </label>
          {selectedSite ? (
            <button type="button" className="ghost-button" disabled={busy} style={{ flex: '1 1 150px', minWidth: 0 }} title={`Set center to the ${selectedSite.label} store pin.`} onClick={() => patch({ centerLat: String(selectedSite.lat), centerLng: String(selectedSite.lng) })}>
              Use store center
            </button>
          ) : null}
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Radius (feet)</span>
            <input type="number" step="any" value={draft.radiusFeet} disabled={busy} style={controlStyle} onChange={(e) => patch({ radiusFeet: e.target.value })} />
          </label>
        </div>
      ) : null}

      {draft.kind === 'zip5_in' ? (
        <label style={{ ...fieldStyle, flex: '1 1 100%', marginTop: 8 }}>
          <span className="subtle-copy">ZIP codes (comma or space separated)</span>
          <input type="text" value={draft.zips} disabled={busy} placeholder="10453, 10458, 10468" style={controlStyle} onChange={(e) => patch({ zips: e.target.value })} />
        </label>
      ) : null}

      {draft.kind === 'us_state_in' ? (
        <label style={{ ...fieldStyle, flex: '1 1 100%', marginTop: 8 }}>
          <span className="subtle-copy">State codes (2-letter, comma separated)</span>
          <input type="text" value={draft.states} disabled={busy} placeholder="NY, NJ, CT" style={controlStyle} onChange={(e) => patch({ states: e.target.value })} />
        </label>
      ) : null}

      {draft.kind === 'scan_time_window' ? (
        <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">On or after (NY date)</span>
            <input type="date" value={draft.sinceDate} disabled={busy} style={controlStyle} onChange={(e) => patch({ sinceDate: e.target.value })} />
          </label>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Before (NY date)</span>
            <input type="date" value={draft.untilDate} disabled={busy} style={controlStyle} onChange={(e) => patch({ untilDate: e.target.value })} />
          </label>
        </div>
      ) : null}

      {draft.kind === 'first_scan_in_days' ? (
        <label style={{ ...compactFieldStyle, marginTop: 8 }}>
          <span className="subtle-copy">No scan in the prior … days</span>
          <input type="number" value={draft.days} disabled={busy} style={controlStyle} onChange={(e) => patch({ days: e.target.value })} />
          <span className="subtle-copy" style={{ fontSize: '0.8em' }}>365 = new or lapsed ≥ 1 year. Needs a person key on the scan.</span>
        </label>
      ) : null}

      {draft.kind === 'age_range' ? (
        <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Min age (blank = none)</span>
            <input type="number" value={draft.minAge} disabled={busy} placeholder="65" style={controlStyle} onChange={(e) => patch({ minAge: e.target.value })} />
          </label>
          <label style={compactFieldStyle}>
            <span className="subtle-copy">Max age (blank = none)</span>
            <input type="number" value={draft.maxAge} disabled={busy} placeholder="34" style={controlStyle} onChange={(e) => patch({ maxAge: e.target.value })} />
          </label>
        </div>
      ) : null}

      {draft.kind === 'gender_in' ? (
        <>
          <div className="inline-row wrap-row" style={{ marginTop: 8, gap: 12 }}>
            {GENDERS.map((g) => (
              <label key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={draft.genders[g]} disabled={busy} onChange={(e) => patch({ genders: { ...draft.genders, [g]: e.target.checked } })} />
                <span className="subtle-copy">{GENDER_LABELS[g]}</span>
              </label>
            ))}
          </div>
          <span className="subtle-copy" style={{ fontSize: '0.8em', display: 'block', marginTop: 6 }}>
            From the scanned government-ID marker, not self-identified gender. Use only when a campaign specifically requires it.
          </span>
        </>
      ) : null}

      <p className="subtle-copy" style={{ marginTop: 8, fontSize: '0.82em' }}>{summary}</p>
    </div>
  )
}

// ===========================================================================
// Rule builder (identity + conditions)
// ===========================================================================

function RuleBuilder({
  siteOptions,
  state,
  onChange,
  busy,
  identityLocked = false,
}: {
  siteOptions: GeoSegmentSiteOption[]
  state: RuleFormState
  onChange: (next: RuleFormState) => void
  busy: boolean
  identityLocked?: boolean
}) {
  const patch = (partial: Partial<RuleFormState>) => onChange({ ...state, ...partial })
  const selectedSite = siteOptions.find((s) => s.siteSlug === state.siteSlug)
  const usedKinds = new Set(state.predicates.map((p) => p.kind))
  const availableKinds = PREDICATE_ORDER.filter((k) => !usedKinds.has(k))

  const setPredicate = (index: number, next: PredicateDraft) => {
    const predicates = state.predicates.slice()
    predicates[index] = next
    patch({ predicates })
  }
  const removePredicate = (index: number) => {
    patch({ predicates: state.predicates.filter((_, i) => i !== index) })
  }
  const addPredicate = (kind: GeoPredicateKind) => {
    patch({ predicates: [...state.predicates, blankDraft(kind, selectedSite)] })
  }
  // Changing the site moves any geofence still sitting on the OLD store
  // pin to the new store pin, so an operator can't silently create a rule
  // for site B using site A's coordinates. A geofence the operator has
  // moved off the pin (a custom point) is left untouched.
  const changeSite = (nextSlug: string) => {
    const nextSite = siteOptions.find((s) => s.siteSlug === nextSlug)
    const predicates =
      nextSite === undefined || selectedSite === undefined
        ? state.predicates
        : state.predicates.map((p) =>
            p.kind === 'geofence' &&
            Number(p.centerLat) === selectedSite.lat &&
            Number(p.centerLng) === selectedSite.lng
              ? { ...p, centerLat: String(nextSite.lat), centerLng: String(nextSite.lng) }
              : p,
          )
    patch({ siteSlug: nextSlug, predicates })
  }

  return (
    <>
      <div className="filter-row wrap-row" style={{ marginTop: 8, alignItems: 'flex-end', gap: 12 }}>
        <label style={fieldStyle}>
          <span className="subtle-copy">Site</span>
          <select
            value={state.siteSlug}
            disabled={busy || identityLocked}
            style={controlStyle}
            onChange={(e) => changeSite(e.target.value)}
          >
            {siteOptions.map((s) => (
              <option key={s.siteSlug} value={s.siteSlug}>{s.label} ({s.siteSlug})</option>
            ))}
            {selectedSite ? null : <option value={state.siteSlug}>{state.siteSlug || '(unknown)'}</option>}
          </select>
        </label>
        <label style={fieldStyle}>
          <span className="subtle-copy">Trigger</span>
          <select value={state.trigger} disabled={busy || identityLocked} style={controlStyle} onChange={(e) => patch({ trigger: e.target.value as GeoSegmentTrigger })}>
            {TRIGGER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label style={compactFieldStyle}>
          <span className="subtle-copy">Dealer id</span>
          <input type="number" value={state.dealerId} disabled={busy || identityLocked} placeholder="210249" style={controlStyle} onChange={(e) => patch({ dealerId: e.target.value })} />
        </label>
        <label style={compactFieldStyle}>
          <span className="subtle-copy">Segment id</span>
          <input type="number" value={state.segmentId} disabled={busy || identityLocked} placeholder="10282" style={controlStyle} onChange={(e) => patch({ segmentId: e.target.value })} />
        </label>
      </div>

      <div style={{ marginTop: 12 }}>
        <span className="subtle-copy"><strong>Conditions</strong>: a customer must match ALL of these:</span>
        {state.predicates.length === 0 ? (
          <p className="subtle-copy" style={{ marginTop: 6 }}>No conditions yet. Add at least one before enabling.</p>
        ) : (
          state.predicates.map((draft, i) => (
            <PredicateCard
              key={`${draft.kind}-${i}`}
              draft={draft}
              siteOptions={siteOptions}
              selectedSite={selectedSite}
              busy={busy}
              onChange={(next) => setPredicate(i, next)}
              onRemove={() => removePredicate(i)}
            />
          ))
        )}
        {availableKinds.length > 0 ? (
          <div className="inline-row wrap-row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
            <span className="subtle-copy">Add condition:</span>
            {availableKinds.map((k) => (
              <button key={k} type="button" className="ghost-button" disabled={busy} style={{ flex: '0 0 auto' }} onClick={() => addPredicate(k)}>
                + {PREDICATE_LABELS[k]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="filter-row wrap-row" style={{ marginTop: 12, alignItems: 'center', gap: 12 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span className="subtle-copy">Enabled (live)</span>
        </label>
        <label style={{ ...fieldStyle, flex: '1 1 240px' }}>
          <span className="subtle-copy">Note (optional)</span>
          <input type="text" value={state.note} disabled={busy} placeholder="What this rule is for" style={controlStyle} onChange={(e) => patch({ note: e.target.value })} />
        </label>
      </div>
    </>
  )
}

// Live, human-readable preview of the whole rule.
function RulePreview({ state }: { state: RuleFormState }) {
  let body: string
  try {
    const ast = buildAst(state)
    body =
      ast.predicates.length === 0
        ? '(no conditions yet; add at least one)'
        : ast.predicates.map(describePredicate).join('; and ')
  } catch (cause) {
    body = cause instanceof Error ? `⚠ ${cause.message}` : '⚠ a condition is incomplete'
  }
  const seg = state.segmentId.trim() === '' ? 'the segment' : `segment ${state.segmentId.trim()}`
  return (
    <p className="subtle-copy" style={{ marginTop: 10 }}>
      <strong>Adds to {seg}</strong> when {TRIGGER_LABELS[state.trigger].toLowerCase()} and {body}.
    </p>
  )
}

// ===========================================================================
// Page
// ===========================================================================

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
      const result = await mutateJson('/api/geo-segment-rules', GeoSegmentRuleMutationResponseSchema, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setNotice({ scope: 'create', message: `Created rule #${result.rule.id} for ${result.rule.siteSlug}.`, segmentId: result.rule.segmentId })
      setCreateState(emptyFormState(siteOptions))
      revalidator.revalidate()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Failed to create rule.')
    } finally {
      setCreating(false)
    }
  }

  async function patchRule(ruleId: number, patch: GeoSegmentRuleUpdateBody, successNotice: ActionNotice): Promise<boolean> {
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
    let predicateJson: GeoPredicateAst
    try {
      predicateJson = buildAst(editState)
      if (editState.enabled && predicateJson.predicates.length === 0) {
        throw new FormError('Add at least one condition before enabling the rule.')
      }
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Invalid rule.')
      return
    }
    // Identity/target fields are immutable server-side; PATCH only the
    // editable parts (conditions, enabled, note).
    const body: GeoSegmentRuleUpdateBody = {
      predicateJson,
      enabled: editState.enabled,
      note: editState.note.trim() === '' ? null : editState.note.trim(),
    }
    const ok = await patchRule(rule.id, body, { scope: rule.id, message: `Saved rule #${rule.id}.`, segmentId: rule.segmentId })
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
      await mutateJson(`/api/geo-segment-rules/${rule.id}`, GeoSegmentRuleDeleteResponseSchema, { method: 'DELETE' })
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
          <details style={{ marginTop: 6 }}>
            <summary className="subtle-copy">About this page</summary>
            <p className="subtle-copy" style={{ marginTop: 6 }}>
              Auto-assign customers to a Sweed marketing segment from their scanned ID. Compose
              conditions (a geofence, home ZIP/state, scan-date window, new/lapsed window, age, ID
              gender marker) and a customer who matches them ALL is added on their next qualifying
              scan. The live on-scan engine evaluates first-scan rules with no deploy. First-purchase
              rules are schema-only today (backfill).
            </p>
          </details>
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
            Template: store radius + no scan in prior 365 days. Set the target Sweed segment + dealer,
            then tune the conditions.
          </p>
          <RuleBuilder siteOptions={siteOptions} state={createState} onChange={setCreateState} busy={creating} />
          <RulePreview state={createState} />
          <div className="filter-row" style={{ marginTop: 12 }}>
            <button
              className="primary-button"
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              style={{ width: '100%', minHeight: 44 }}
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
            const totalApplications = rule.stats.applied + rule.stats.alreadyMember + rule.stats.failed + rule.stats.pending
            const deletable = !rule.enabled && totalApplications === 0
            const deleteHint = rule.enabled
              ? 'Disable the rule before deleting it.'
              : totalApplications > 0
                ? 'This rule has application history; leave it disabled instead of deleting.'
                : 'Delete this rule.'
            const conditions =
              rule.predicateJson.predicates.length === 0
                ? '(no conditions)'
                : rule.predicateJson.predicates.map(describePredicate).join('; and ')
            return (
              <article className="history-card" key={rule.id}>
                <div className="history-card-topline wrap-row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>
                      {rule.siteLabel ?? rule.siteSlug} ({rule.siteSlug}) · {TRIGGER_LABELS[rule.trigger]}
                    </strong>
                    <p className="subtle-copy" style={{ marginTop: 2 }}>
                      rule #{rule.id} · segment{' '}
                      <a href={sweedSegmentUrl(rule.segmentId)} target="_blank" rel="noreferrer">{rule.segmentId}</a> · dealer {rule.dealerId}
                    </p>
                    <p className="subtle-copy" style={{ marginTop: 2 }}>{conditions}</p>
                    {rule.note ? <p className="subtle-copy" style={{ marginTop: 2 }}>{rule.note}</p> : null}
                    <p className="subtle-copy" style={{ marginTop: 2 }}>updated {nyLongDateTime(Date.parse(rule.updatedAt))} NY</p>
                  </div>
                  <div className="inline-row wrap-row">
                    <Pill tone={rule.enabled ? 'success' : 'muted'}>{rule.enabled ? 'enabled' : 'disabled'}</Pill>
                    <Pill tone={rule.triggerLive ? 'success' : 'warning'}>{rule.triggerLive ? 'live on-scan' : 'backfill only'}</Pill>
                  </div>
                </div>

                <div className="inline-row wrap-row" style={{ marginTop: 10, gap: 8 }}>
                  <Pill tone="success">{`${rule.stats.applied} added`}</Pill>
                  <Pill tone="muted">{`${rule.stats.alreadyMember} already member`}</Pill>
                  {rule.stats.pending > 0 ? <Pill tone="warning">{`${rule.stats.pending} pending`}</Pill> : null}
                  {rule.stats.failed > 0 ? <Pill tone="danger">{`${rule.stats.failed} failed`}</Pill> : null}
                </div>

                {canEdit ? (
                  <div className="filter-row wrap-row" style={{ marginTop: 12, gap: 8 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busy}
                        onChange={(e) =>
                          void patchRule(rule.id, { enabled: e.target.checked }, {
                            scope: rule.id,
                            message: `${e.target.checked ? 'Enabled' : 'Disabled'} rule #${rule.id}.`,
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
                          setEditState(formStateFromRule(rule, siteOptions))
                        }
                      }}
                    >
                      {isEditing ? 'Close' : 'Edit'}
                    </button>
                    <button type="button" className="ghost-button" disabled={busy || !deletable} title={deleteHint} onClick={() => void handleDelete(rule)}>
                      Delete
                    </button>
                    {busy ? <span className="subtle-copy">saving…</span> : null}
                  </div>
                ) : null}

                {typeof notice?.scope === 'number' && notice.scope === rule.id ? <ActionNoticeStrip notice={notice} /> : null}

                {isEditing && editState ? (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--control-border, #d8d8d8)' }}>
                    <p className="subtle-copy" style={{ marginBottom: 4 }}>
                      Site, dealer, segment, and trigger are fixed for an existing rule. To retarget, create a new rule.
                    </p>
                    <RuleBuilder siteOptions={siteOptions} state={editState} onChange={setEditState} busy={busy} identityLocked />
                    <RulePreview state={editState} />
                    <div className="filter-row" style={{ marginTop: 12, gap: 8 }}>
                      <button type="button" className="primary-button" disabled={busy} style={{ minHeight: 44 }} onClick={() => void handleSaveEdit(rule)}>
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
