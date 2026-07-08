/**
 * Pure clustering logic for the agent-waste review backlog (issue #68,
 * parent virusdave/top-level#51).
 *
 * The impure Bedrock call lives in ./clusterModel.ts. THIS file owns every
 * deterministic invariant so it can be unit-tested without a gateway:
 *
 *  - the exact keyed payload we send to the model (0-based integer `key`
 *    per observation, because AgentWasteObservation.id is a STABLE TRIGGER
 *    id and NOT unique per event, so it cannot be the round-trip key);
 *  - the raw model-output wire schema (shape only);
 *  - rehydration: map model-returned keys back to full observations,
 *    dropping hallucinated / out-of-range / duplicate keys and guaranteeing
 *    every input observation lands in exactly one cluster OR `unclustered`;
 *  - the aggregate-waste ranking, computed ONLY from the observations' real
 *    `estimated_wasted_*` numbers (never from the model), so the operator's
 *    "fix the most expensive problems first" ordering is trustworthy.
 */

import { z } from 'zod'

import type {
  AgentWasteCluster,
  AgentWasteObservation,
} from '../../shared/contracts/api/agentWaste.js'

/**
 * Single-shot prompt budget. The pending backlog is "tiny and rare" by
 * design, so one cluster call should always fit; this cap is a guardrail
 * against a pathological backlog blowing the model's context, and the route
 * degrades with a structured 413 rather than silently clustering a prefix.
 */
export const MAX_CLUSTER_OBSERVATIONS = 200

/** Server-side cap on the model-authored `label` (display-only text). */
export const MAX_CLUSTER_LABEL_CHARS = 80

/**
 * The per-observation shape sent to the model. We deliberately OMIT
 * `estimated_wasted_*`: similarity grouping should be driven by what the
 * problem IS (kind / id / repo / severity / note), not by how expensive it
 * was — the server ranks by the real numbers afterward. `note` is the main
 * human signal, so it is included (read/analysis by a private model, not the
 * injection the promote allowlist guards).
 */
export interface KeyedClusterInput {
  key: number
  kind: string
  id: string
  severity?: string
  repo?: string
  note?: string
}

/** Build the keyed payload (index === key) the model is asked to cluster. */
export function buildKeyedClusterInput(
  observations: readonly AgentWasteObservation[],
): KeyedClusterInput[] {
  return observations.map((obs, key) => {
    const entry: KeyedClusterInput = { key, kind: obs.kind, id: obs.id }
    if (obs.severity !== undefined) entry.severity = obs.severity
    if (obs.repo !== undefined) entry.repo = obs.repo
    if (obs.note !== undefined) entry.note = obs.note
    return entry
  })
}

/**
 * Raw model output — SHAPE validation only. Key validity, range, dedupe, and
 * primary/member fallbacks are the rehydrator's job, not the schema's. Kept
 * separate from the public response contract: this is untrusted wire data.
 */
export const RawClusterModelOutputSchema = z
  .object({
    clusters: z.array(
      z
        .object({
          label: z.string(),
          primaryKey: z.number().int(),
          memberKeys: z.array(z.number().int()),
        })
        .strip(),
    ),
  })
  .strip()
export type RawClusterModelOutput = z.infer<typeof RawClusterModelOutputSchema>

/** Clamp a possibly-missing/NaN/negative estimate to a finite, >=0 number. */
function normalizeWaste(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }
  return value
}

/** Trim + collapse whitespace + cap length of the model's display label. */
function sanitizeLabel(label: string): string {
  const collapsed = label.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_CLUSTER_LABEL_CHARS
    ? collapsed.slice(0, MAX_CLUSTER_LABEL_CHARS).trimEnd()
    : collapsed
}

/** Sum the members' real waste estimates (missing/invalid count as 0). */
function aggregateWaste(members: readonly AgentWasteObservation[]): {
  aggregateWastedTokens: number
  aggregateWastedSeconds: number
} {
  let aggregateWastedTokens = 0
  let aggregateWastedSeconds = 0
  for (const m of members) {
    aggregateWastedTokens += normalizeWaste(m.estimated_wasted_tokens)
    aggregateWastedSeconds += normalizeWaste(m.estimated_wasted_seconds)
  }
  return { aggregateWastedTokens, aggregateWastedSeconds }
}

/**
 * Descending "likely aggregate agent waste": primarily total wasted tokens,
 * then total wasted seconds, then member count (so a large all-unrated
 * cluster still surfaces above tiny ones), then label for a stable order.
 */
export function compareClustersByWaste(a: AgentWasteCluster, b: AgentWasteCluster): number {
  if (a.aggregateWastedTokens !== b.aggregateWastedTokens) {
    return b.aggregateWastedTokens - a.aggregateWastedTokens
  }
  if (a.aggregateWastedSeconds !== b.aggregateWastedSeconds) {
    return b.aggregateWastedSeconds - a.aggregateWastedSeconds
  }
  if (a.count !== b.count) {
    return b.count - a.count
  }
  return a.label.localeCompare(b.label)
}

/**
 * Rehydrate the model's key groups into full, ranked clusters.
 *
 * Invariants (all tested):
 *  - every returned key maps back to an in-range input observation;
 *  - a key can appear in at most one cluster (first cluster wins);
 *  - hallucinated / out-of-range / duplicate keys are dropped;
 *  - a group that retains no keys is dropped entirely;
 *  - `primary` is always one of the cluster's own `members`;
 *  - every input observation ends up in exactly one cluster OR `unclustered`
 *    (sum(members) + unclustered === observations.length);
 *  - clusters are sorted descending by aggregate waste.
 */
export function rehydrateClusters(
  observations: readonly AgentWasteObservation[],
  raw: RawClusterModelOutput,
): { clusters: AgentWasteCluster[]; unclustered: AgentWasteObservation[] } {
  const inRange = (k: number): boolean => Number.isInteger(k) && k >= 0 && k < observations.length
  const used = new Set<number>()
  const clusters: AgentWasteCluster[] = []

  for (const group of raw.clusters) {
    // Retain member keys: in-range, not-yet-used, de-duplicated (per group
    // AND across groups via `used`).
    const retained: number[] = []
    const seen = new Set<number>()
    for (const k of group.memberKeys) {
      if (!inRange(k) || used.has(k) || seen.has(k)) continue
      seen.add(k)
      retained.push(k)
    }
    // Fold in a valid, unused primaryKey the model omitted from memberKeys.
    if (inRange(group.primaryKey) && !used.has(group.primaryKey) && !seen.has(group.primaryKey)) {
      seen.add(group.primaryKey)
      retained.push(group.primaryKey)
    }
    if (retained.length === 0) continue

    // Deterministic member order (ascending key); mark them consumed.
    retained.sort((a, b) => a - b)
    for (const k of retained) used.add(k)

    const primaryKey =
      inRange(group.primaryKey) && retained.includes(group.primaryKey)
        ? group.primaryKey
        : retained[0]
    const members = retained.map((k) => observations[k])
    const primary = observations[primaryKey]
    const { aggregateWastedTokens, aggregateWastedSeconds } = aggregateWaste(members)

    clusters.push({
      label: sanitizeLabel(group.label),
      primary,
      members,
      count: members.length,
      aggregateWastedTokens,
      aggregateWastedSeconds,
    })
  }

  clusters.sort(compareClustersByWaste)

  const unclustered = observations.filter((_, key) => !used.has(key))
  return { clusters, unclustered }
}
