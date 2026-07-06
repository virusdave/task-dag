// Pure, unit-testable helpers for the agent-waste review-queue page
// (issue #57, ask #1: the admin review-queue UI). Kept separate from the
// React component so the sorting/coloring/fetch-degrade logic can be
// tested without a DOM (this repo's client tests are logic-only; there is
// no jsdom/testing-library harness).

import {
  AGENT_WASTE_SEVERITIES,
  AgentWasteBacklogResponseSchema,
  AgentWasteUnavailableResponseSchema,
  type AgentWasteBacklogResponse,
  type AgentWasteObservation,
  type AgentWasteSourceStatus,
} from '../../../shared/contracts/index.js'
import type { PillProps } from '../../components/Pill.js'
import { buildAppPath } from '../../app/paths.js'

/**
 * Where a human goes to actually PROMOTE an observation into the reviewed
 * advisory catalog. Promotion edits `advisories.yaml` in virusdave/top-level
 * and IS a behavior-changing mutation (it adds allowlisted text the
 * dispatcher may inject into future agents), so it is deliberately NOT a
 * Helios button in v1 -- the page only links toward it (operator decision on
 * issue #57). The catalog contract governing that file lives alongside it.
 */
export const ADVISORY_CATALOG_URL =
  'https://github.com/virusdave/top-level/blob/master/docs/agent-runtime/advisories.yaml'
export const ADVISORY_CATALOG_DOC_URL =
  'https://github.com/virusdave/top-level/blob/master/docs/agent-runtime/ADVISORY_CATALOG.md'

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
