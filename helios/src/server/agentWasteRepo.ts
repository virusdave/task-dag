/**
 * Agent-waste review-queue — server-side reader layer (issue #57).
 *
 * CONSUMER-SIDE ONLY. This module defines the interface the review-queue
 * UI + route consume, WITHOUT deciding how the backlog is physically read.
 * That transport (same-host NDJSON read vs. a read-only bridge) is a
 * separate, operator-gated task — see the sibling "wire the real transport
 * reader" leaf on issue #57.
 *
 * Until that transport lands, the default reader reports the source as
 * unavailable and throws AgentWasteUnavailableError, so the route degrades
 * to a structured 503 (`agent_waste_unavailable`) — exactly like
 * taskDagRepo.ts / routes/taskDag.ts degrade to 503 `task_dag_unavailable`,
 * NOT a raw 500. This lets the whole UI be built and reviewed against a
 * stable contract before the physical transport is chosen.
 */

import {
  AgentWasteObservationSchema,
  type AgentWasteObservation,
  type AgentWasteSourceStatus,
} from '../shared/contracts/api/agentWaste.js'

/** Thrown when the agent-waste backlog source is not currently readable. */
export class AgentWasteUnavailableError extends Error {
  status: AgentWasteSourceStatus
  constructor(status: AgentWasteSourceStatus) {
    super('Agent-waste backlog data source is unavailable')
    this.name = 'AgentWasteUnavailableError'
    this.status = status
  }
}

/**
 * Pluggable backlog transport. The transport leaf installs a concrete
 * implementation via {@link setBacklogReader}; the route always calls the
 * current reader through {@link getBacklog} / {@link getBacklogSourceStatus}.
 */
export interface BacklogReader {
  /** Cheap, synchronous availability probe (no I/O). */
  status(): AgentWasteSourceStatus
  /**
   * Read the observations awaiting human review. Throws
   * AgentWasteUnavailableError when the source cannot be read.
   */
  readBacklog(): Promise<AgentWasteObservation[]>
}

const UNAVAILABLE_STATUS: AgentWasteSourceStatus = {
  available: false,
  detail:
    'Agent-waste backlog transport is not yet wired. The read path (same-host ' +
    'NDJSON read vs. a read-only bridge) is a separate, operator-gated task on ' +
    'issue #57.',
}

/**
 * Default reader: reports "unavailable" until the transport leaf lands.
 * Every read fails safe (structured 503), never a raw 500.
 */
export const unavailableBacklogReader: BacklogReader = {
  status(): AgentWasteSourceStatus {
    return UNAVAILABLE_STATUS
  },
  async readBacklog(): Promise<AgentWasteObservation[]> {
    throw new AgentWasteUnavailableError(UNAVAILABLE_STATUS)
  },
}

let currentReader: BacklogReader = unavailableBacklogReader

/** Install the concrete transport reader (called by the transport leaf). */
export function setBacklogReader(reader: BacklogReader): void {
  currentReader = reader
}

/** Test-only: restore the default unavailable reader. */
export function __resetBacklogReaderForTests(): void {
  currentReader = unavailableBacklogReader
}

export function getBacklogSourceStatus(): AgentWasteSourceStatus {
  return currentReader.status()
}

export function getBacklog(): Promise<AgentWasteObservation[]> {
  return currentReader.readBacklog()
}

/**
 * Defensive NDJSON parser the transport reader will use.
 *
 * The store is append-only NDJSON written best-effort by parallel workers,
 * so a crashed writer can leave a single torn line. We skip+warn on any
 * unparseable / schema-invalid line rather than zeroing the whole list —
 * one bad line must never hide every valid observation from the reviewer.
 * Exposed (and tested) here so the transport leaf reuses one hardened
 * parser instead of hand-rolling its own.
 */
export function parseBacklogNdjson(
  raw: string,
  warn: (message: string) => void = (m) => console.warn(m),
): AgentWasteObservation[] {
  const out: AgentWasteObservation[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      warn(`agent-waste: skipping torn NDJSON backlog line ${i + 1} (invalid JSON)`)
      continue
    }
    const parsed = AgentWasteObservationSchema.safeParse(value)
    if (!parsed.success) {
      warn(`agent-waste: skipping malformed backlog observation on line ${i + 1}`)
      continue
    }
    out.push(parsed.data)
  }
  return out
}
