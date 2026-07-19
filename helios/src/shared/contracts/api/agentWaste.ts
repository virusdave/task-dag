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

/** Sum real waste estimates, treating missing, non-finite, or negative values as zero. */
export function aggregateWaste(members: readonly AgentWasteObservation[]): {
  aggregateWastedTokens: number
  aggregateWastedSeconds: number
} {
  const normalize = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

  let aggregateWastedTokens = 0
  let aggregateWastedSeconds = 0
  for (const member of members) {
    aggregateWastedTokens += normalize(member.estimated_wasted_tokens)
    aggregateWastedSeconds += normalize(member.estimated_wasted_seconds)
  }
  return { aggregateWastedTokens, aggregateWastedSeconds }
}

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

// ─────────────────────────────────────────────────────────────────────────
// Promote-to-advisory (issue #61 — the D3 admin button).
//
// An admin promotes a reviewed observation into the reviewed advisory catalog
// (`advisories.yaml` in virusdave/top-level). This is a BEHAVIOR-CHANGING
// mutation: the selector may inject the advisory's `text` into future agents.
//
// SAFETY GATE = OPERATOR APPROVAL (not text provenance). The fleet already
// runs on agent- and Oracle-authored agentic instructions, so LLM-drafted
// advisory text is acceptable — PROVIDED an operator reviews/approves (or
// edits) it before it lands. The load-bearing invariant is therefore: no
// operator-unapproved text ever reaches the injected allowlist. The admin
// authenticated + submitting this request IS that approval. (The in-Helios
// LLM draft-assist that proposes candidate text is a separate step; whatever
// the admin finally submits here is, by definition, operator-approved.)
//
// The observation's display-only `note` is not a field here — the request is
// rejected (`.strict()`) if it is supplied. This is hygiene, not the primary
// invariant: we never SILENTLY route a free-form observation note into the
// committed `text`; the operator authors/approves the text explicitly.
//
// Field mapping (audited): the source observation contributes only its `id`
// (echoed into `trigger_ids` + recorded as the audit source) and, as a UI
// default, its `severity`. The injected `text` is whatever the operator
// approves and submits.

/** kebab-case: lowercase alnum groups joined by single hyphens. */
export const ADVISORY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Safe charset for observation ids (trigger ids + the audit source id). These
 * flow into git commit trailers and the YAML entry, so they must contain no
 * whitespace/control chars that could corrupt the audit record or the file.
 * Observation ids in practice look like `rg-short-r-rejected`.
 */
export const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/** Byte cap on advisory `text` (token-by-wordcount does not bound bytes). */
export const ADVISORY_TEXT_MAX_BYTES = 8192

/**
 * Token proxy shared by the advisory-catalog contract, the selector, and the
 * `agent-prompt-budget` CI check: `tokens(s) = ceil(1.3 × wordcount)`. It
 * MUST match the contract's definition exactly (a mismatch would let one
 * side accept a catalog the other rejects). Exposed here so the client can
 * show a live token estimate against `max_tokens` while the admin types.
 */
export function estimateAdvisoryTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length
  return Math.ceil(1.3 * words)
}

/** Design-§8 ceilings the catalog `budget` block may never exceed. */
export const ADVISORY_BUDGET_MAX_TOTAL_TOKENS_CEILING = 500
export const ADVISORY_BUDGET_MAX_ADVISORIES_CEILING = 5
export const ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MIN = 7
export const ADVISORY_DEFAULT_EXPIRES_AFTER_DAYS_MAX = 14

/**
 * Statuses a *promotion* may create. The catalog also allows `retired`
 * (dismiss/provenance), but "promote" deliberately only mints an injectable
 * entry — an admin dismisses via a different, non-injecting path, so
 * accepting `retired` from the promote button would be confusing (Oracle
 * design review, issue #61).
 */
export const PromotableAdvisoryStatusSchema = z.enum(['active', 'permanent-safety'])
export type PromotableAdvisoryStatus = z.infer<typeof PromotableAdvisoryStatusSchema>

export const AdvisorySeveritySchema = z.enum(['low', 'medium', 'high', 'safety'])
export type AdvisorySeverity = z.infer<typeof AdvisorySeveritySchema>

/** `global` or `repo:<owner>/<repo>` (contract `scope`). */
export const AdvisoryScopeSchema = z
  .string()
  .trim()
  .refine((s) => s === 'global' || /^repo:[^\s/]+\/[^\s/]+$/.test(s), {
    message: 'scope must be "global" or "repo:<owner>/<repo>"',
  })

// Reject control characters (except we forbid newlines/tabs too) so a
// promoted `text` stays a single, well-formed line and cannot smuggle
// terminal escapes or break the single-line YAML flow entry.
const NO_CONTROL_CHARS = (s: string) => !/[\u0000-\u001f\u007f]/.test(s)

export const PromoteAdvisoryRequestSchema = z
  .object({
    /** Stable, unique catalog id (kebab-case). Distinct from observation ids. */
    id: z.string().trim().min(1).max(100).regex(ADVISORY_ID_PATTERN, {
      message: 'id must be kebab-case (lowercase alphanumerics separated by single hyphens)',
    }),
    status: PromotableAdvisoryStatusSchema,
    scope: AdvisoryScopeSchema,
    severity: AdvisorySeveritySchema,
    /** Per-advisory token cap on `text`; must be ≤ the catalog budget. */
    max_tokens: z.number().int().positive().max(ADVISORY_BUDGET_MAX_TOTAL_TOKENS_CEILING),
    /**
     * The ONLY field the selector ever injects. Human-authored + reviewed,
     * single line, no control chars. Length-capped in bytes in addition to
     * the token cap (token-by-wordcount does not bound raw bytes).
     */
    text: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine(NO_CONTROL_CHARS, { message: 'text must not contain control characters or newlines' })
      .refine((s) => new TextEncoder().encode(s).length <= ADVISORY_TEXT_MAX_BYTES, {
        message: `text must be at most ${ADVISORY_TEXT_MAX_BYTES} bytes`,
      }),
    /** Observation-event ids that count as recurrences of this advisory. */
    trigger_ids: z
      .array(
        z.string().trim().min(1).max(200).regex(OBSERVATION_ID_PATTERN, {
          message: 'trigger id contains disallowed characters',
        }),
      )
      .max(50)
      .default([]),
    /** TTL from `added` (active only; omit to use the catalog default). */
    expires_after_days: z.number().int().min(1).max(365).optional(),
    promote_to_guardrail: z.boolean().optional(),
    /** Human-only review context; NEVER injected. Optional, bounded. */
    notes: z
      .string()
      .trim()
      .max(2000)
      .refine(NO_CONTROL_CHARS, { message: 'notes must not contain control characters' })
      .optional(),
    /**
     * The observation this promotion came from — used ONLY for the commit
     * message / audit provenance, NEVER mapped into any advisory field.
     */
    sourceObservationId: z.string().trim().min(1).max(200).regex(OBSERVATION_ID_PATTERN, {
      message: 'sourceObservationId contains disallowed characters',
    }),
  })
  .strict() // reject unknown fields — e.g. an observation `note` cannot be silently routed into the committed entry
  .superRefine((val, ctx) => {
    if (val.status === 'active' && val.trigger_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trigger_ids'],
        message: 'an active advisory must list at least one trigger id',
      })
    }
    if (val.status === 'permanent-safety' && val.expires_after_days !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_after_days'],
        message: 'a permanent-safety advisory must not set expires_after_days',
      })
    }
    if (estimateAdvisoryTokens(val.text) > val.max_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `text is ~${estimateAdvisoryTokens(val.text)} tokens, over max_tokens=${val.max_tokens}`,
      })
    }
  })
export type PromoteAdvisoryRequest = z.infer<typeof PromoteAdvisoryRequestSchema>

/** Structured failure codes for the promote path. */
export const PROMOTE_ADVISORY_FAILURE_CODES = [
  'agent_pain_points_unavailable',
  'invalid_request',
  'catalog_current_invalid',
  'id_exists',
  'catalog_result_invalid',
  'catalog_edit_unsupported',
  'no_op',
  'unexpected_staged_changes',
  'git_command_failed',
  'git_push_failed',
] as const
export const PromoteAdvisoryFailureCodeSchema = z.enum(PROMOTE_ADVISORY_FAILURE_CODES)
export type PromoteAdvisoryFailureCode = z.infer<typeof PromoteAdvisoryFailureCodeSchema>

/** 200 body on a successful promotion. */
export const PromoteAdvisoryResponseSchema = z.object({
  ok: z.literal(true),
  /** Advisory id that was added. */
  id: z.string(),
  /** File path committed, relative to the agent-pain-points repo root. */
  relPath: z.string(),
  /** Commit SHA created in virusdave/agent-pain-points. */
  commitSha: z.string(),
  /** GitHub URL of the commit, for the UI to link to. */
  commitUrl: z.string(),
  /** False ⇒ push succeeded but the remote already had our HEAD. */
  pushed: z.boolean(),
})
export type PromoteAdvisoryResponse = z.infer<typeof PromoteAdvisoryResponseSchema>

/** Non-2xx body on a failed promotion. */
export const PromoteAdvisoryErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: PromoteAdvisoryFailureCodeSchema,
  message: z.string(),
})
export type PromoteAdvisoryErrorResponse = z.infer<typeof PromoteAdvisoryErrorResponseSchema>

// ─────────────────────────────────────────────────────────────────────────
// Cluster the pending backlog by theme (issue #68, parent virusdave/top-level#51).
//
// An admin presses "Cluster similar reports" and the server sends the live
// pending backlog to an ADVANCED private Bedrock model (via bedrock-mantle)
// that groups near-duplicate / highly-similar observations. The result is
// DISPLAY-ONLY: it is never injected into an agent, never auto-promoted, and
// (v1) never persisted. Sending observation text — including the display-only
// `note` — to the *private* clustering model is read/analysis, not the
// injection the promote allowlist guards; the output only renders in the
// operator UI.
//
// The model returns only the GROUPING (which observations belong together +
// a short human label + a representative). The "likely aggregate agent
// waste" ranking is computed DETERMINISTICALLY in Helios from the members'
// real `estimated_wasted_*` numbers — never taken from the model — so the
// ordering is trustworthy and reproducible.

/**
 * Request body for POST /api/agent-waste/clusters. Empty + `.strict()`: the
 * server reads the live backlog itself, so no client-supplied scope/rows can
 * silently change what gets clustered.
 */
export const AgentWasteClustersRequestSchema = z.object({}).strict()
export type AgentWasteClustersRequest = z.infer<typeof AgentWasteClustersRequestSchema>

/** Must stay aligned with the server-side label sanitizer. */
export const MAX_CLUSTER_LABEL_CHARS = 80

/**
 * One clustered group, ready to render and already ranked server-side.
 * `members` includes `primary` and is non-empty; `count === members.length`
 * (enforced below). The aggregates are computed in Helios from the members'
 * real estimates, never from the model.
 */
export const AgentWasteClusterSchema = z
  .object({
    /** Short human theme from the model (server-capped, display-only). */
    label: z.string(),
    /** Representative member (also present in `members`). */
    primary: AgentWasteObservationSchema,
    /** All members of the cluster, including `primary`. */
    members: z.array(AgentWasteObservationSchema).min(1),
    /** members.length. */
    count: z.number().int().positive(),
    /** sum(estimated_wasted_tokens over members; missing/invalid = 0). */
    aggregateWastedTokens: z.number().nonnegative(),
    /** sum(estimated_wasted_seconds over members; missing/invalid = 0). */
    aggregateWastedSeconds: z.number().nonnegative(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.count !== val.members.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['count'],
        message: `count (${val.count}) must equal members.length (${val.members.length})`,
      })
    }
  })
export type AgentWasteCluster = z.infer<typeof AgentWasteClusterSchema>

/** 200 body for POST /api/agent-waste/clusters. */
export const AgentWasteClustersResponseSchema = z
  .object({
    /** Reused backlog source status (available/detail). */
    source: AgentWasteSourceStatusSchema,
    /** The model id that actually ran (resolved override-then-default). */
    model: z.string(),
    /** Clusters, sorted descending by aggregate agent waste. */
    clusters: z.array(AgentWasteClusterSchema),
    /** Observations the model left ungrouped (empty array, never omitted). */
    unclustered: z.array(AgentWasteObservationSchema),
  })
  .strict()
export type AgentWasteClustersResponse = z.infer<typeof AgentWasteClustersResponseSchema>

// ─────────────────────────────────────────────────────────────────────────
// Draft a GitHub ticket from a reviewed cluster (issue #76).
//
// This request identifies the source reports only. The server verifies the
// exact report multiset against the current backlog before it asks a model to
// draft anything, then derives a stable filing key from those reports. The
// model-authored label and later operator edits are deliberately excluded
// from that key so a retry cannot mint another identity for the same reports.

/** Large enough for today's backlog while still bounding request work. */
export const AGENT_WASTE_TICKET_MAX_REPORTS = 2_000

/** Bound strings that otherwise inherit the producer's permissive schema. */
export const AGENT_WASTE_TICKET_MAX_REQUEST_BYTES = 512 * 1024

/** Ticket identity must reject, not silently strip, unknown source fields. */
export const AgentWasteTicketReportSchema = AgentWasteObservationSchema.strict()

export const AgentWasteTicketDraftRequestSchema = z
  .object({
    /** Display-only cluster theme; not part of the stable filing identity. */
    clusterLabel: z.string().trim().min(1).max(MAX_CLUSTER_LABEL_CHARS),
    /** Exact cluster members, including duplicate events when present. */
    reports: z.array(AgentWasteTicketReportSchema).min(1).max(AGENT_WASTE_TICKET_MAX_REPORTS),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= AGENT_WASTE_TICKET_MAX_REQUEST_BYTES,
    {
      message: `ticket draft request must be at most ${AGENT_WASTE_TICKET_MAX_REQUEST_BYTES} bytes`,
    },
  )
export type AgentWasteTicketDraftRequest = z.infer<typeof AgentWasteTicketDraftRequestSchema>

/** One curated repository that may receive an operator-approved ticket. */
export const AgentWasteTicketRepositorySchema = z
  .object({
    repository: z.string().min(3).max(100),
    description: z.string().trim().min(1).max(300),
  })
  .strict()
export type AgentWasteTicketRepository = z.infer<typeof AgentWasteTicketRepositorySchema>

/** 200 body for the bounded, read-only ticket-target catalog. */
export const AgentWasteTicketRepositoriesResponseSchema = z
  .object({ repositories: z.array(AgentWasteTicketRepositorySchema).max(16) })
  .strict()
export type AgentWasteTicketRepositoriesResponse = z.infer<
  typeof AgentWasteTicketRepositoriesResponseSchema
>

const TicketDraftTextSchema = z
  .string()
  .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value), {
    message: 'must not contain control characters',
  })
  .transform((value) => value.trim())

/** Strict model-authored proposal. Every field remains operator-editable. */
export const AgentWasteTicketProposalSchema = z
  .object({
    title: z
      .string()
      .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value), {
        message: 'must not contain control characters',
      })
      .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), {
        message: 'title must be a single line',
      })
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(160)),
    summary: TicketDraftTextSchema.pipe(z.string().min(1).max(6_000)),
    repository: z.string().min(3).max(100),
  })
  .strict()
export type AgentWasteTicketProposal = z.infer<typeof AgentWasteTicketProposalSchema>

/** Successful proposal plus immutable source provenance and advisory rationale. */
export const AgentWasteTicketDraftResponseSchema = z
  .object({
    model: z.string().min(1).max(200),
    filingKey: z.string().regex(/^[0-9a-f]{64}$/u),
    draft: AgentWasteTicketProposalSchema,
    rationale: TicketDraftTextSchema.pipe(z.string().min(1).max(1_000)),
    evidenceMarkdown: z.string().min(1),
  })
  .strict()
export type AgentWasteTicketDraftResponse = z.infer<typeof AgentWasteTicketDraftResponseSchema>

export const AGENT_WASTE_TICKET_FAILURE_CODES = [
  'invalid_request',
  'agent_waste_unavailable',
  'agent_waste_ticket_source_mismatch',
  'agent_waste_ticket_input_too_large',
  'bedrock_unconfigured',
  'bedrock_http_error',
  'bedrock_transport_error',
  'bedrock_unexpected_response',
] as const
export const AgentWasteTicketFailureCodeSchema = z.enum(AGENT_WASTE_TICKET_FAILURE_CODES)
export type AgentWasteTicketFailureCode = z.infer<typeof AgentWasteTicketFailureCodeSchema>

/** Structured failure codes for the cluster path. */
export const AGENT_WASTE_CLUSTER_FAILURE_CODES = [
  'agent_waste_unavailable',
  'bedrock_unconfigured',
  'agent_waste_cluster_input_too_large',
  'bedrock_http_error',
  'bedrock_transport_error',
  'bedrock_unexpected_response',
] as const
export const AgentWasteClusterFailureCodeSchema = z.enum(AGENT_WASTE_CLUSTER_FAILURE_CODES)
export type AgentWasteClusterFailureCode = z.infer<typeof AgentWasteClusterFailureCodeSchema>

/**
 * Structured error body when the generated model payload would be too large.
 * The client POST body is empty, but the live backlog can, in principle,
 * exceed the single-shot prompt budget; rather than silently clustering only
 * the first N observations (which would misrepresent a partial result as
 * complete), the server refuses with 413 and these counts so the UI can
 * explain the cap.
 */
export const AgentWasteClusterInputTooLargeResponseSchema = z.object({
  error: z.literal('agent_waste_cluster_input_too_large'),
  message: z.string(),
  observationCount: z.number().int().nonnegative(),
  maxObservations: z.number().int().positive(),
})
export type AgentWasteClusterInputTooLargeResponse = z.infer<
  typeof AgentWasteClusterInputTooLargeResponseSchema
>
