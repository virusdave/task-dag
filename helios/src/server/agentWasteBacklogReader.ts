/**
 * Agent-waste backlog reader — agent-pain-points-mirror transport (issue
 * #64, the automation/Helios child of the agent-pain-points migration —
 * parent virusdave/top-level#40).
 *
 * This is the concrete {@link BacklogReader} that wires the previously
 * unwired `setBacklogReader()` hook in agentWasteRepo.ts to a real source:
 * the pending-review backlog file github-worker exports into
 * `virusdave/agent-pain-points`, read read-only through the dedicated git
 * mirror (agentPainPointsMirror.ts). It replaces the default
 * `unavailableBacklogReader` so `GET /api/agent-waste/backlog` returns real
 * items instead of the 503-degrade default.
 *
 * (Before the agent-pain-points migration this read the same file out of
 * `virusdave/top-level`; the migration moved the canonical storage into the
 * dedicated advisories repo so agent-waste writes no longer bump the canon
 * SHA. The relative path is unchanged.)
 *
 * Semantics (loud-but-non-fatal, taskDagMirror-style):
 *   - Mirror unavailable (no read key / never fetched / no last-good copy)
 *     → status.available = false; readBacklog throws
 *     AgentWasteUnavailableError → the route degrades to a structured 503,
 *     NEVER a raw 500.
 *   - Mirror available but the backlog file does not exist yet (exporter
 *     hasn't written it) → status.available = true, readBacklog returns []
 *     — a missing backlog is fail-safe empty, not an error (design: "ship
 *     it empty and fail-safe").
 *   - Mirror available and file present → parsed via the hardened
 *     parseBacklogNdjson() against the Zod contract. A single torn line is
 *     skipped, never zeroing the whole list.
 *
 * INVARIANT (carried from the contract): the `note` field is display-only.
 * This reader only surfaces observations to the admin UI; nothing here (or
 * anywhere on the read path) injects backlog content into an agent.
 */

import {
  AgentWasteUnavailableError,
  parseBacklogNdjson,
  setBacklogReader,
  type BacklogReader,
} from './agentWasteRepo.js'
import {
  getAgentPainPointsMirrorSourceStatus,
  readAgentPainPointsFile,
} from './agentPainPointsMirror.js'
import type {
  AgentWasteObservation,
  AgentWasteSourceStatus,
} from '../shared/contracts/api/agentWaste.js'

/**
 * Path (relative to the agent-pain-points repo root) of the exported
 * pending-review backlog file, co-located with
 * docs/agent-runtime/advisories.yaml. The relative path is preserved across
 * the migration; env-overridable so a different filename can be pinned
 * without a Helios code change.
 */
const DEFAULT_BACKLOG_PATH = 'docs/agent-runtime/agent-waste-backlog.ndjson'

function backlogPath(): string {
  const v = (process.env.HELIOS_AGENT_WASTE_BACKLOG_PATH ?? '').trim()
  return v === '' ? DEFAULT_BACKLOG_PATH : v
}

function unavailableDetail(): string {
  const m = getAgentPainPointsMirrorSourceStatus()
  const parts = [`agent-pain-points mirror unavailable (mode=${m.mode})`]
  if (m.lastError) parts.push(`last error: ${m.lastError}`)
  return parts.join('; ')
}

/**
 * Backlog reader backed by the read-only agent-pain-points git mirror.
 */
export const agentPainPointsBacklogReader: BacklogReader = {
  status(): AgentWasteSourceStatus {
    const mirror = getAgentPainPointsMirrorSourceStatus()
    if (!mirror.available) {
      return { available: false, detail: unavailableDetail() }
    }
    return {
      available: true,
      detail: `Reading ${backlogPath()} from the agent-pain-points mirror (mode=${mirror.mode}).`,
    }
  },

  async readBacklog(): Promise<AgentWasteObservation[]> {
    const mirror = getAgentPainPointsMirrorSourceStatus()
    if (!mirror.available) {
      throw new AgentWasteUnavailableError({
        available: false,
        detail: unavailableDetail(),
      })
    }
    let raw: string | null
    try {
      raw = await readAgentPainPointsFile(backlogPath())
    } catch (err) {
      // The mirror probed as available but the read itself failed (e.g. a
      // transient git error). Surface as unavailable (503), never a 500.
      const detail =
        err instanceof Error
          ? `Failed to read ${backlogPath()} from agent-pain-points mirror: ${err.message}`
          : `Failed to read ${backlogPath()} from agent-pain-points mirror.`
      throw new AgentWasteUnavailableError({ available: false, detail })
    }
    // Absent file = fail-safe empty backlog (exporter hasn't written yet).
    if (raw == null) return []
    return parseBacklogNdjson(raw)
  },
}

/**
 * Install the agent-pain-points-mirror-backed backlog reader, replacing the
 * default unavailable reader. Call once at server startup, AFTER
 * initAgentPainPointsMirror.
 */
export function initAgentWasteBacklogReader(): void {
  setBacklogReader(agentPainPointsBacklogReader)
}
