import type {
  AgentWasteObservation,
  AgentWasteTicketDraftRequest,
} from '../../shared/contracts/api/agentWaste.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'
import { aggregateWaste } from './clusterBacklog.js'

const FILING_KEY_VERSION = 'agent-waste-ticket-v1'

type CanonicalObservation = {
  [Key in keyof Required<AgentWasteObservation>]: Exclude<AgentWasteObservation[Key], undefined> | null
}

export interface VerifiedTicketDraftSource {
  filingKey: string
  clusterLabel: string
  reports: AgentWasteObservation[]
  reportCount: number
  aggregateWastedTokens: number
  aggregateWastedSeconds: number
  evidenceMarkdown: string
}

export type VerifyTicketDraftSourceResult =
  | { ok: true; source: VerifiedTicketDraftSource }
  | { ok: false; missingReportFingerprints: string[] }

/**
 * Explicit mapped object used by both multiset verification and filing-key
 * derivation. `CanonicalObservation` makes a newly added contract field a
 * compile error here. Changing this shape also requires a filing-key version
 * and reconciliation decision: existing issue markers use the v1 digest.
 */
export function canonicalTicketObservation(obs: AgentWasteObservation): CanonicalObservation {
  return {
    time: obs.time,
    kind: obs.kind,
    id: obs.id,
    severity: obs.severity ?? null,
    repo: obs.repo ?? null,
    task_sha: obs.task_sha ?? null,
    estimated_wasted_tokens: obs.estimated_wasted_tokens ?? null,
    estimated_wasted_seconds: obs.estimated_wasted_seconds ?? null,
    note: obs.note ?? null,
    host: obs.host ?? null,
  }
}

function canonicalObservationJson(obs: AgentWasteObservation): string {
  return stableJsonStringify(canonicalTicketObservation(obs))
}

export function ticketReportFingerprint(obs: AgentWasteObservation): string {
  return sha256(canonicalObservationJson(obs))
}

/**
 * Order-independent but multiplicity-preserving identity for the source
 * reports. Cluster labels and operator/model-authored ticket text are not
 * source identity and therefore do not participate.
 */
export function ticketFilingKey(reports: readonly AgentWasteObservation[]): string {
  const reportPayloads = reports.map(canonicalObservationJson).sort()
  return sha256(stableJsonStringify({ version: FILING_KEY_VERSION, reports: reportPayloads }))
}

function html(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function code(value: string): string {
  return `<code>${html(value)}</code>`
}

function formatEstimate(value: number | undefined, unit: string): string {
  return value === undefined ? 'not reported' : `${value.toLocaleString('en-US')} ${unit}`
}

function taskLink(obs: AgentWasteObservation): string | null {
  if (!obs.repo || !obs.task_sha) return null
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]+$/.test(obs.repo)) return null
  if (!/^[0-9a-f]{7,40}$/i.test(obs.task_sha)) return null
  const [owner, repo] = obs.repo.split('/')
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${obs.task_sha}`
  return `[${code(obs.task_sha)}](${url})`
}

/** Deterministic, model-independent evidence appended to the editable draft. */
export function renderTicketEvidence(reports: readonly AgentWasteObservation[]): string {
  const sorted = reports
    .map((report) => ({ report, canonical: canonicalObservationJson(report) }))
    .sort((left, right) => (left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0))
  const lines = ['## Source reports', '']

  sorted.forEach(({ report }, index) => {
    lines.push(`${index + 1}. ${code(report.kind)} / ${code(report.id)} at ${code(report.time)}`)
    if (report.repo) lines.push(`   - Repository: ${code(report.repo)}`)
    const linkedTask = taskLink(report)
    if (linkedTask) lines.push(`   - Task commit: ${linkedTask}`)
    else if (report.task_sha) lines.push(`   - Task: ${code(report.task_sha)}`)
    if (report.severity) lines.push(`   - Severity: ${code(report.severity)}`)
    if (report.host) lines.push(`   - Host: ${code(report.host)}`)
    lines.push(
      `   - Estimated waste: ${formatEstimate(report.estimated_wasted_tokens, 'tokens')}; ${formatEstimate(report.estimated_wasted_seconds, 'seconds')}`,
    )
    if (report.note) {
      lines.push('   - Report note:')
      const normalizedNote = report.note.replace(/\r\n?/g, '\n')
      lines.push(`     <pre><code>${html(normalizedNote)}</code></pre>`)
    }
    lines.push('')
  })

  return lines.join('\n').trimEnd()
}

/**
 * Verify the requested reports are an exact available multiset subset of the
 * current backlog. Counts are decremented as matches are consumed, so two
 * byte-identical requested events require two byte-identical live events.
 */
export function verifyTicketDraftSource(
  request: AgentWasteTicketDraftRequest,
  currentBacklog: readonly AgentWasteObservation[],
): VerifyTicketDraftSourceResult {
  const available = new Map<string, number>()
  for (const report of currentBacklog) {
    const fingerprint = ticketReportFingerprint(report)
    available.set(fingerprint, (available.get(fingerprint) ?? 0) + 1)
  }

  const missingReportFingerprints: string[] = []
  for (const report of request.reports) {
    const fingerprint = ticketReportFingerprint(report)
    const remaining = available.get(fingerprint) ?? 0
    if (remaining === 0) {
      missingReportFingerprints.push(fingerprint)
    } else {
      available.set(fingerprint, remaining - 1)
    }
  }
  if (missingReportFingerprints.length > 0) {
    return { ok: false, missingReportFingerprints }
  }

  const reports = [...request.reports]
  const { aggregateWastedTokens, aggregateWastedSeconds } = aggregateWaste(reports)
  return {
    ok: true,
    source: {
      filingKey: ticketFilingKey(reports),
      clusterLabel: request.clusterLabel,
      reports,
      reportCount: reports.length,
      aggregateWastedTokens,
      aggregateWastedSeconds,
      evidenceMarkdown: renderTicketEvidence(reports),
    },
  }
}
