import { z } from 'zod'

// Agent-waste review-queue API contract (issue #57).
//
// Agents record structured "wasted effort" observations (footguns,
// repeated startup work, …) to an append-only NDJSON store owned by the
// github-worker dispatcher. A human reviews that backlog and, when a
// pattern is worth acting on, promotes it to the reviewed advisory catalog.
// Nothing agent-authored is ever auto-injected; the human review step is
// the safety gate. This contract is the shape the admin review-queue UI
// consumes.
//
// Field source of truth: Nicponskis/github-worker docs/AGENT_WASTE.md
// (`agent-waste backlog --format json`). Only `time`, `kind`, and `id` are
// guaranteed; every other field is optional because `record` is
// schema-permissive (it appends whatever it is given). Readers therefore
// parse DEFENSIVELY — a single torn line is skipped, never zeroing the
// whole list (see server/agentWasteRepo.ts).

/**
 * Known severity buckets used by the github-worker producer. Stored as a
 * free-form string in the observation (below) so an unexpected value from
 * a future producer version is displayed, not dropped — this enum is the
 * documented set for UI ordering/coloring only.
 */
export const AGENT_WASTE_SEVERITIES = ['low', 'medium', 'high', 'safety'] as const
export const AgentWasteSeveritySchema = z.enum(AGENT_WASTE_SEVERITIES)
export type AgentWasteSeverity = z.infer<typeof AgentWasteSeveritySchema>

/**
 * A single observation event awaiting human review.
 *
 * `note` is a free-form, human-only string: it is shown in the review UI
 * and MUST NEVER be injected into an agent's prompt. Keeping it a plain
 * display string in the contract encodes that boundary.
 */
export const AgentWasteObservationSchema = z.object({
  /** ISO-8601 timestamp the observation was recorded (guaranteed). */
  time: z.string(),
  /** Observation category, e.g. `tool_footgun` (guaranteed). */
  kind: z.string(),
  /** Stable trigger id, e.g. `rg-short-r-rejected` (guaranteed). */
  id: z.string(),
  /** One of AGENT_WASTE_SEVERITIES in practice; kept permissive. */
  severity: z.string().optional(),
  /** Work repo the observation came from, e.g. `owner/name`. */
  repo: z.string().optional(),
  /** task-dag task sha the observation was recorded under. */
  task_sha: z.string().optional(),
  estimated_wasted_tokens: z.number().optional(),
  estimated_wasted_seconds: z.number().optional(),
  /** DISPLAY-ONLY free-form note. NEVER injected into agents. */
  note: z.string().optional(),
  /** Host the observation was recorded on. */
  host: z.string().optional(),
})
export type AgentWasteObservation = z.infer<typeof AgentWasteObservationSchema>

/**
 * Status of the underlying backlog data source. Lets the UI distinguish a
 * genuinely-empty backlog (`available: true`, empty array) from a not-yet
 * wired / temporarily unreadable transport (`available: false`, 503).
 */
export const AgentWasteSourceStatusSchema = z.object({
  available: z.boolean(),
  /** Human-readable explanation of where the data comes from / why not. */
  detail: z.string(),
})
export type AgentWasteSourceStatus = z.infer<typeof AgentWasteSourceStatusSchema>

/** 200 body for GET /api/agent-waste/backlog. */
export const AgentWasteBacklogResponseSchema = z.object({
  source: AgentWasteSourceStatusSchema,
  observations: z.array(AgentWasteObservationSchema),
})
export type AgentWasteBacklogResponse = z.infer<typeof AgentWasteBacklogResponseSchema>

/**
 * 503 body when the backlog source is unavailable. Mirrors the taskDag
 * `task_dag_unavailable` degrade shape so the client can render a friendly
 * "unavailable" state instead of a raw 500.
 */
export const AgentWasteUnavailableResponseSchema = z.object({
  error: z.literal('agent_waste_unavailable'),
  message: z.string(),
  source: AgentWasteSourceStatusSchema,
})
export type AgentWasteUnavailableResponse = z.infer<typeof AgentWasteUnavailableResponseSchema>
