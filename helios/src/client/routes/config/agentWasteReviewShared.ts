// Pure, unit-testable helpers for the agent-waste review-queue page
// (issue #57, ask #1: the admin review-queue UI). Kept separate from the
// React component so the sorting/coloring/fetch-degrade logic can be
// tested without a DOM (this repo's client tests are logic-only; there is
// no jsdom/testing-library harness).

import {
  AGENT_WASTE_SEVERITIES,
  AgentWasteBacklogResponseSchema,
  AgentWasteClustersResponseSchema,
  AgentWasteUnavailableResponseSchema,
  PromoteAdvisoryErrorResponseSchema,
  PromoteAdvisoryRequestSchema,
  PromoteAdvisoryResponseSchema,
  aggregateWaste,
  estimateAdvisoryTokens,
  type AgentWasteBacklogResponse,
  type AgentWasteCluster,
  type AgentWasteClustersResponse,
  type AgentWasteObservation,
  type AgentWasteSourceStatus,
  type AdvisorySeverity,
  type PromoteAdvisoryRequest,
  type PromoteAdvisoryResponse,
  type PromotableAdvisoryStatus,
} from '../../../shared/contracts/index.js'
import type { PillProps } from '../../components/Pill.js'
import { buildAppPath } from '../../app/paths.js'

/**
 * The reviewed advisory catalog an observation is promoted INTO. Promotion
 * edits `advisories.yaml` in virusdave/agent-pain-points and IS a
 * behavior-changing mutation (it adds allowlisted text the dispatcher may
 * inject into future agents). As of issue #61 this is done via an in-Helios
 * admin button (server-side commit+push; operator decision D3), so these
 * links are just for reference. The catalog contract governing that file
 * lives alongside it. (Issue #64 moved this storage out of virusdave/top-level
 * into the dedicated agent-pain-points repo.)
 */
export const ADVISORY_CATALOG_URL =
  'https://github.com/virusdave/agent-pain-points/blob/master/docs/agent-runtime/advisories.yaml'
export const ADVISORY_CATALOG_DOC_URL =
  'https://github.com/virusdave/agent-pain-points/blob/master/docs/agent-runtime/ADVISORY_CATALOG.md'

/**
 * Raised when GET /api/agent-waste/backlog returns the structured 503
 * (`agent_waste_unavailable`). Carries the source-status detail so the UI
 * can explain WHY the backlog is unreadable instead of showing a raw error.
 * Mirrors the taskDag `TaskDataUnavailableError` degrade pattern.
 */
export class AgentWasteBacklogUnavailableError extends Error {
  readonly detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.name = 'AgentWasteBacklogUnavailableError'
    this.detail = detail
  }
}

/**
 * Fetch the review backlog. Returns the parsed 200 body, or throws
 * AgentWasteBacklogUnavailableError on the structured 503 so callers render
 * a friendly "unavailable" state. Any other non-OK response throws a plain
 * Error carrying the status. Uses buildAppPath so it honors APP_BASE_PATH.
 */
export async function fetchAgentWasteBacklog(): Promise<AgentWasteBacklogResponse> {
  const res = await fetch(buildAppPath('/api/agent-waste/backlog'), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 503) {
    const parsed = AgentWasteUnavailableResponseSchema.safeParse(await res.json())
    if (parsed.success) {
      throw new AgentWasteBacklogUnavailableError(parsed.data.message, parsed.data.source.detail)
    }
    throw new AgentWasteBacklogUnavailableError(
      'Agent-waste backlog data is temporarily unavailable.',
      'The backlog source did not report a status.',
    )
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`)
  }
  return AgentWasteBacklogResponseSchema.parse(await res.json())
}

/**
 * Pill color for a severity. `safety` is the most serious (a guardrail /
 * production-safety footgun) and `low` the least. Unknown values from a
 * future producer fall through to muted so they are shown, never dropped.
 */
export function severityTone(severity: string | undefined): NonNullable<PillProps['tone']> {
  switch (severity) {
    case 'safety':
      return 'danger'
    case 'high':
      return 'warning'
    case 'medium':
      // Pill has no distinct "info" tone; medium falls to muted (severity is
      // always spelled out in the pill text, so color need only flag the
      // scary end of the scale). success/green would misread as "good".
      return 'muted'
    case 'low':
      return 'muted'
    default:
      return 'muted'
  }
}

/**
 * Sort weight for a severity: higher == more serious. Used only as a
 * time-tiebreak so equal-timestamp rows put the scarier item on top.
 * Unknown severities sort last (weight -1).
 */
export function severityRank(severity: string | undefined): number {
  // -1 for unknown/absent, else 0..3 (low..safety) by declaration order.
  return (AGENT_WASTE_SEVERITIES as readonly string[]).indexOf(severity ?? '')
}

/**
 * Newest-first ordering for the review queue, tie-broken by descending
 * severity. Times are ISO-8601 strings; invalid/missing timestamps sort to
 * the bottom rather than throwing.
 */
export function compareObservations(a: AgentWasteObservation, b: AgentWasteObservation): number {
  const ta = Date.parse(a.time)
  const tb = Date.parse(b.time)
  const va = Number.isNaN(ta) ? -Infinity : ta
  const vb = Number.isNaN(tb) ? -Infinity : tb
  if (va !== vb) {
    return vb - va
  }
  return severityRank(b.severity) - severityRank(a.severity)
}

/**
 * Stable identity for a single observation, used for client-side "dismiss"
 * (hide-locally) bookkeeping. There is no server-guaranteed unique id, so we
 * hash the immutable fields together. Two byte-identical observations
 * collapse to one key -- acceptable for a hide-locally affordance.
 */
export function observationKey(obs: AgentWasteObservation): string {
  return [
    obs.time,
    obs.kind,
    obs.id,
    obs.severity ?? '',
    obs.repo ?? '',
    obs.task_sha ?? '',
    obs.host ?? '',
    obs.note ?? '',
    obs.estimated_wasted_tokens?.toString() ?? '',
    obs.estimated_wasted_seconds?.toString() ?? '',
  ].join('\u0001')
}

/**
 * Discriminated view state for the page, derived purely from the fetch
 * lifecycle plus the count of observations still VISIBLE after local
 * dismissals. Keeping this pure makes the loading/unavailable/error/empty/
 * ready branching unit-testable.
 */
export type AgentWasteViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string; detail: string }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; source: AgentWasteSourceStatus }
  | { kind: 'ready'; source: AgentWasteSourceStatus; visibleCount: number }

export function deriveViewState(input: {
  loading: boolean
  data: AgentWasteBacklogResponse | null
  error: Error | null
  visibleCount: number
}): AgentWasteViewState {
  const { loading, data, error, visibleCount } = input
  // Keep showing last-good data across background refreshes; only fall to
  // loading/error/unavailable when we have nothing to show.
  if (data) {
    if (data.observations.length === 0) {
      return { kind: 'empty', source: data.source }
    }
    return { kind: 'ready', source: data.source, visibleCount }
  }
  if (loading) {
    return { kind: 'loading' }
  }
  if (error instanceof AgentWasteBacklogUnavailableError) {
    return { kind: 'unavailable', message: error.message, detail: error.detail }
  }
  if (error) {
    return { kind: 'error', message: error.message }
  }
  return { kind: 'loading' }
}

// ─────────────────────────────────────────────────────────────────────────
// Promote-to-advisory (issue #61). The admin approves the allowlisted `text`
// (the only field ever injected into an agent) — typed, pasted from an LLM
// draft, or produced by the in-Helios draft-assist and then reviewed. The
// safety gate is operator APPROVAL, not provenance. `text` starts blank (it is
// never auto-filled from the observation's display-only `note`); the
// observation contributes only provenance: its id (as a trigger id + audit
// source) and, as a convenience default, its severity.

/** Editable form state for a single promotion. All strings for input binding. */
export interface PromoteFormState {
  id: string
  status: PromotableAdvisoryStatus
  scope: string
  severity: AdvisorySeverity
  maxTokens: string
  text: string
  triggerIdsCsv: string
  expiresAfterDays: string
  notes: string
}

const VALID_SEVERITIES = new Set<AdvisorySeverity>(['low', 'medium', 'high', 'safety'])

/** Coerce an observation's free-form severity to a valid advisory severity. */
export function toAdvisorySeverity(severity: string | undefined): AdvisorySeverity {
  return severity && VALID_SEVERITIES.has(severity as AdvisorySeverity)
    ? (severity as AdvisorySeverity)
    : 'medium'
}

/**
 * Seed the promote form from an observation. `text` is intentionally EMPTY —
 * the admin writes the reviewed, allowlisted advisory text. The observation
 * id seeds `trigger_ids` (recurrence linkage) and the audit source; severity
 * is a starting default only.
 */
export function defaultPromoteFormState(obs: AgentWasteObservation): PromoteFormState {
  return {
    id: '',
    status: 'active',
    scope: 'global',
    severity: toAdvisorySeverity(obs.severity),
    maxTokens: '35',
    text: '',
    triggerIdsCsv: obs.id,
    expiresAfterDays: '',
    notes: '',
  }
}

/** Split a comma/whitespace-separated trigger-id list into a clean array. */
export function parseTriggerIds(csv: string): string[] {
  return csv
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build a PromoteAdvisoryRequest from form state and validate it with the
 * SHARED contract schema (the same schema the server enforces). Returns the
 * parsed request or a list of `field: message` errors for inline display.
 * `sourceObservationId` is fixed from the observation and never editable.
 */
export function buildPromoteRequest(
  state: PromoteFormState,
  sourceObservationId: string,
):
  | { ok: true; request: PromoteAdvisoryRequest }
  | { ok: false; errors: string[] } {
  const candidate: Record<string, unknown> = {
    id: state.id.trim(),
    status: state.status,
    scope: state.scope.trim(),
    severity: state.severity,
    max_tokens: Number(state.maxTokens),
    text: state.text,
    trigger_ids: parseTriggerIds(state.triggerIdsCsv),
    sourceObservationId,
  }
  if (state.expiresAfterDays.trim() !== '') {
    candidate.expires_after_days = Number(state.expiresAfterDays)
  }
  if (state.notes.trim() !== '') {
    candidate.notes = state.notes
  }
  const parsed = PromoteAdvisoryRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(form)'}: ${i.message}`,
      ),
    }
  }
  return { ok: true, request: parsed.data }
}

/** Live token estimate of the advisory text (matches the server proxy). */
export function promoteTextTokens(text: string): number {
  return estimateAdvisoryTokens(text)
}

// ─────────────────────────────────────────────────────────────────────────
// Cluster similar reports (issue #68, parent virusdave/top-level#51). The
// admin presses a button; the server sends the live backlog to an advanced
// private Bedrock model that GROUPS near-duplicate observations, and Helios
// ranks the clusters deterministically by real aggregate waste. The result is
// DISPLAY-ONLY — never injected into any agent. These helpers are pure so the
// fetch/parse/defensive-sort logic is unit-tested without a DOM.

/**
 * Structured outcome of the cluster request. Never throws for an expected
 * server rejection (503 unconfigured / unavailable, 413 too-large, 502
 * gateway); the UI renders `code`/`message` inline, exactly like the promote
 * path. Only a truly unexpected shape yields `bad_response`.
 */
export type ClusterFetchResult =
  | { ok: true; response: AgentWasteClustersResponse }
  | { ok: false; code: string; message: string }

/**
 * Defensive descending sort by "likely aggregate agent waste": tokens, then
 * seconds, then member count, then label. The server already sorts, so this
 * only guards against a future server change or a hand-built response; it
 * mirrors the server's compareClustersByWaste. Returns a new array.
 */
export function sortClustersByWaste(clusters: readonly AgentWasteCluster[]): AgentWasteCluster[] {
  return [...clusters].sort((a, b) => {
    if (a.aggregateWastedTokens !== b.aggregateWastedTokens) {
      return b.aggregateWastedTokens - a.aggregateWastedTokens
    }
    if (a.aggregateWastedSeconds !== b.aggregateWastedSeconds) {
      return b.aggregateWastedSeconds - a.aggregateWastedSeconds
    }
    if (a.count !== b.count) {
      return b.count - a.count
    }
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })
}

/** Best-effort extraction of an {error, message} pair from a JSON error body. */
function readErrorBody(json: unknown, fallbackStatus: number): { code: string; message: string } {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>
    const code = typeof rec.error === 'string' ? rec.error : `http_${fallbackStatus}`
    const message = typeof rec.message === 'string' ? rec.message : `Request failed (${fallbackStatus})`
    return { code, message }
  }
  return { code: `http_${fallbackStatus}`, message: `Request failed (${fallbackStatus})` }
}

/**
 * POST to the cluster endpoint and parse the response. The request body is
 * empty (the server reads the live backlog). Returns a discriminated result;
 * expected server rejections come back as `{ok:false, code, message}` and the
 * defensive re-sort is applied to a successful body's clusters.
 */
export async function fetchAgentWasteClusters(): Promise<ClusterFetchResult> {
  let res: Response
  try {
    res = await fetch(buildAppPath('/api/agent-waste/clusters'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    })
  } catch (cause) {
    return { ok: false, code: 'network_error', message: cause instanceof Error ? cause.message : 'Network error' }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ok: false, code: 'bad_response', message: `Request failed (${res.status})` }
  }

  if (!res.ok) {
    return { ok: false, ...readErrorBody(json, res.status) }
  }

  const parsed = AgentWasteClustersResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, code: 'bad_response', message: 'The server returned an unexpected cluster shape.' }
  }
  return {
    ok: true,
    response: { ...parsed.data, clusters: sortClustersByWaste(parsed.data.clusters) },
  }
}

/**
 * The members of a cluster OTHER than its primary, for the collapsed
 * "expand to see the rest" list. `members` includes the primary, so we drop
 * the first member whose identity matches the primary (by observationKey).
 */
export function clusterOtherMembers(cluster: AgentWasteCluster): AgentWasteObservation[] {
  const primaryKey = observationKey(cluster.primary)
  let removed = false
  return cluster.members.filter((m) => {
    if (!removed && observationKey(m) === primaryKey) {
      removed = true
      return false
    }
    return true
  })
}

/**
 * Move one exact member occurrence from a displayed cluster to the response's
 * ungrouped list. This changes only the local cluster snapshot; the flat
 * backlog remains the canonical review list.
 */
export function evictClusterMember(
  response: AgentWasteClustersResponse,
  clusterIndex: number,
  memberIndex: number,
): AgentWasteClustersResponse {
  const cluster = response.clusters[clusterIndex]
  const evicted = cluster?.members[memberIndex]
  if (!cluster || !evicted) {
    return response
  }

  const members = cluster.members.filter((_, index) => index !== memberIndex)
  const clusters = response.clusters.filter((_, index) => index !== clusterIndex)
  if (members.length > 0) {
    const primaryIndex = cluster.members.findIndex(
      (member) => observationKey(member) === observationKey(cluster.primary),
    )
    const primary = memberIndex === primaryIndex ? members[0] : cluster.primary
    clusters.push({
      ...cluster,
      primary,
      members,
      count: members.length,
      ...aggregateWaste(members),
    })
  }

  return {
    ...response,
    clusters: sortClustersByWaste(clusters),
    unclustered: [...response.unclustered, evicted],
  }
}

/** Human-friendly one-liner for a cluster failure `code`. */
export function describeClusterError(code: string, message: string): string {
  switch (code) {
    case 'agent_waste_unavailable':
      return `The review backlog is temporarily unavailable, so it can’t be clustered. ${message}`
    case 'bedrock_unconfigured':
      return `The clustering model is not configured on this server. ${message}`
    case 'agent_waste_cluster_input_too_large':
      return message
    case 'bedrock_http_error':
    case 'bedrock_transport_error':
    case 'bedrock_unexpected_response':
      return `The clustering model could not complete the request. ${message}`
    default:
      return message
  }
}

export type PromoteSubmitResult =
  | { ok: true; response: PromoteAdvisoryResponse }
  | { ok: false; code: string; message: string }

/**
 * POST a validated promotion to the admin endpoint. Never throws for an
 * expected server rejection — returns a structured `{ok:false, code, message}`
 * so the UI can render it inline (including the 503 `agent_pain_points_unavailable`
 * degrade when the write path is not yet wired).
 */
export async function submitPromoteAdvisory(
  request: PromoteAdvisoryRequest,
): Promise<PromoteSubmitResult> {
  let res: Response
  try {
    res = await fetch(buildAppPath('/api/agent-waste/promote'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (cause) {
    return { ok: false, code: 'network_error', message: cause instanceof Error ? cause.message : 'Network error' }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ok: false, code: 'bad_response', message: `Request failed (${res.status})` }
  }

  if (res.ok) {
    const parsed = PromoteAdvisoryResponseSchema.safeParse(json)
    if (parsed.success) {
      return { ok: true, response: parsed.data }
    }
    return { ok: false, code: 'bad_response', message: 'The server returned an unexpected success shape.' }
  }

  const err = PromoteAdvisoryErrorResponseSchema.safeParse(json)
  if (err.success) {
    return { ok: false, code: err.data.code, message: err.data.message }
  }
  return { ok: false, code: 'error', message: `Request failed (${res.status})` }
}
