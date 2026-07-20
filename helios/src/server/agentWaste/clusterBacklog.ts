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
import { aggregateWaste, MAX_CLUSTER_LABEL_CHARS } from '../../shared/contracts/api/agentWaste.js'
export { aggregateWaste } from '../../shared/contracts/api/agentWaste.js'
export { MAX_CLUSTER_LABEL_CHARS } from '../../shared/contracts/api/agentWaste.js'

/**
 * Per-call prompt budget. Larger backlogs are split into batches of this
 * size; every batch must succeed before the route returns a result, so the
 * operator never sees a silently truncated clustering.
 */
export const CLUSTER_BATCH_SIZE = 200

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its', 'not',
  'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'they', 'this',
  'to', 'was', 'we', 'were', 'will', 'with', 'you', 'your',
])

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export function occurrenceIdentity(observation: AgentWasteObservation, position: number): string {
  return `${canonical(observation)}\u0000${position.toString().padStart(12, '0')}`
}

export function normalizeTokens(...values: Array<string | undefined>): Set<string> {
  const normalized = values.filter((value): value is string => value !== undefined)
    .join(' ').normalize('NFKC').toLowerCase()
    .replace(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/gu, ' ')
  return new Set(normalized.split(/[^a-z0-9]+/u).filter((token) => token && !STOPWORDS.has(token)))
}

export interface BaselineComponent {
  keys: number[]
  identity: string
  cluster: AgentWasteCluster
}

export interface RefinementUnit {
  index: number
  keys: number[]
  components: BaselineComponent[]
  oversized: boolean
}

function deterministicCluster(observations: readonly AgentWasteObservation[], keys: number[]): AgentWasteCluster {
  const ordered = [...keys].sort((a, b) => compareCodeUnits(occurrenceIdentity(observations[a], a), occurrenceIdentity(observations[b], b)))
  const primaryKey = [...ordered].sort((a, b) => {
    const aw = aggregateWaste([observations[a]])
    const bw = aggregateWaste([observations[b]])
    return bw.aggregateWastedTokens - aw.aggregateWastedTokens || bw.aggregateWastedSeconds - aw.aggregateWastedSeconds ||
      compareCodeUnits(occurrenceIdentity(observations[a], a), occurrenceIdentity(observations[b], b))
  })[0]
  const members = ordered.map((key) => observations[key])
  const labels = ordered.map((key) => `${observations[key].kind}:${observations[key].id}`.normalize('NFKC').toLowerCase()).sort(compareCodeUnits)
  return { label: sanitizeLabel(labels[0]), primary: observations[primaryKey], members, count: members.length,
    ...aggregateWaste(members), provenance: 'deterministic' }
}

/** Deterministic full-backlog connected-component baseline. */
export function buildDeterministicBaseline(observations: readonly AgentWasteObservation[]): {
  components: BaselineComponent[]; clusters: AgentWasteCluster[]; unclustered: AgentWasteObservation[]
} {
  const tokens = observations.map((observation) => normalizeTokens(observation.kind, observation.id, observation.repo, observation.note))
  const exact = observations.map((observation) => `${observation.kind.normalize('NFKC').toLowerCase()}\u0000${observation.id.normalize('NFKC').toLowerCase()}`)
  const parent = observations.map((_, index) => index)
  const find = (key: number): number => parent[key] === key ? key : (parent[key] = find(parent[key]))
  const join = (a: number, b: number): void => { const ar = find(a); const br = find(b); if (ar !== br) parent[br] = ar }
  const inverted = new Map<string, number[]>()
  tokens.forEach((set, key) => set.forEach((token) => {
    const posting = inverted.get(token)
    if (posting) posting.push(key)
    else inverted.set(token, [key])
  }))
  const exactFirst = new Map<string, number>()
  exact.forEach((value, key) => { const first = exactFirst.get(value); if (first === undefined) exactFirst.set(value, key); else join(first, key) })
  // Count candidates one source occurrence at a time. This retains O(n)
  // counters at worst instead of materializing the O(n²) pair set produced by
  // one common token; only pairs with the required three shared tokens reach
  // the Jaccard calculation.
  for (let a = 0; a < observations.length; a += 1) {
    const sharedByCandidate = new Map<number, number>()
    for (const token of tokens[a]) {
      for (const b of inverted.get(token) ?? []) {
        if (b > a) sharedByCandidate.set(b, (sharedByCandidate.get(b) ?? 0) + 1)
      }
    }
    for (const [b, shared] of sharedByCandidate) {
      if (shared < 3) continue
      const union = tokens[a].size + tokens[b].size - shared
      if (union > 0 && shared / union >= 0.6) join(a, b)
    }
  }
  const grouped = new Map<number, number[]>()
  observations.forEach((_, key) => { const root = find(key); grouped.set(root, [...(grouped.get(root) ?? []), key]) })
  const components = [...grouped.values()].map((keys) => {
    const cluster = deterministicCluster(observations, keys)
    return { keys, cluster, identity: keys.map((key) => occurrenceIdentity(observations[key], key)).sort(compareCodeUnits)[0] }
  }).sort((a, b) => compareClustersByWaste(a.cluster, b.cluster) || compareCodeUnits(a.identity, b.identity))
  return { components, clusters: components.filter((c) => c.keys.length > 1).map((c) => c.cluster),
    unclustered: components.filter((c) => c.keys.length === 1).map((c) => observations[c.keys[0]]) }
}

export function buildRefinementUnits(components: readonly BaselineComponent[]): RefinementUnit[] {
  const units: RefinementUnit[] = []
  let packed: BaselineComponent[] = []
  let count = 0
  const flush = (): void => { if (packed.length) { units.push({ index: units.length, components: packed, keys: packed.flatMap((c) => c.keys), oversized: false }); packed = []; count = 0 } }
  for (const component of components) {
    if (component.keys.length > CLUSTER_BATCH_SIZE) { flush(); units.push({ index: units.length, components: [component], keys: component.keys, oversized: true }); continue }
    if (count + component.keys.length > CLUSTER_BATCH_SIZE) flush()
    packed.push(component); count += component.keys.length
  }
  flush()
  return units
}

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

/** Trim + collapse whitespace + cap length of the model's display label. */
function sanitizeLabel(label: string): string {
  const collapsed = label.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_CLUSTER_LABEL_CHARS
    ? collapsed.slice(0, MAX_CLUSTER_LABEL_CHARS).trimEnd()
    : collapsed
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
  return compareCodeUnits(a.label, b.label)
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
): { clusters: AgentWasteCluster[]; clusterKeys: number[][]; unclustered: AgentWasteObservation[]; unclusteredKeys: number[] } {
  const inRange = (k: number): boolean => Number.isInteger(k) && k >= 0 && k < observations.length
  const used = new Set<number>()
  const entries: Array<{ cluster: AgentWasteCluster; keys: number[] }> = []

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

    entries.push({
      cluster: {
        label: sanitizeLabel(group.label),
        primary,
        members,
        count: members.length,
        aggregateWastedTokens,
        aggregateWastedSeconds,
        provenance: 'model_refined',
      },
      keys: retained,
    })
  }

  entries.sort((a, b) => compareClustersByWaste(a.cluster, b.cluster)
    || compareCodeUnits(a.keys.join(','), b.keys.join(',')))

  const unclusteredKeys = observations.map((_, key) => key).filter((key) => !used.has(key))
  return {
    clusters: entries.map((entry) => entry.cluster),
    clusterKeys: entries.map((entry) => entry.keys),
    unclustered: unclusteredKeys.map((key) => observations[key]),
    unclusteredKeys,
  }
}
