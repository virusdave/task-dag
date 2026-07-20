// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentWasteClustersResponse, AgentWasteObservation } from '../../../shared/contracts/index.js'

const mocks = vi.hoisted(() => ({
  backlog: vi.fn(),
  clusters: vi.fn(),
}))

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useRouteLoaderData: () => undefined,
}))
vi.mock('./configSidebarSubtree.js', () => ({ useRegisterConfigSidebarSubtree: () => undefined }))
vi.mock('./agentWasteReviewShared.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agentWasteReviewShared.js')>(),
  fetchAgentWasteBacklog: mocks.backlog,
  fetchAgentWasteClusters: mocks.clusters,
}))

import { AgentWasteReviewPage } from './AgentWasteReviewPage.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function observation(id: string, tokens: number, seconds: number): AgentWasteObservation {
  return { time: '2026-07-20T12:00:00.000Z', kind: 'duplicate-work', id, estimated_wasted_tokens: tokens, estimated_wasted_seconds: seconds }
}

describe('AgentWasteReviewPage cluster undo', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.clearAllMocks()
  })

  it('restores the exact duplicate occurrence, aggregates, ranking, and remove-button focus without I/O', async () => {
    const exactDuplicate = observation('duplicate', 700, 70)
    const otherOccurrence = observation('duplicate', 300, 30)
    const lowerRanked = observation('lower', 500, 50)
    const clustered: AgentWasteClustersResponse = {
      source: { available: true, detail: 'test' }, model: 'test-model',
      clusters: [
        { label: 'First', primary: exactDuplicate, members: [exactDuplicate, otherOccurrence], count: 2, aggregateWastedTokens: 1000, aggregateWastedSeconds: 100, provenance: 'model_refined' },
        { label: 'Second', primary: lowerRanked, members: [lowerRanked], count: 1, aggregateWastedTokens: 500, aggregateWastedSeconds: 50, provenance: 'deterministic' },
      ],
      unclustered: [], inputCount: 3, outputCount: 3, coverageComplete: true,
      refinementComplete: true, refinementTotal: 1, refinementSucceeded: 1,
      refinementFailed: 0, refinementSkipped: 0, warnings: [],
    }
    mocks.backlog.mockResolvedValue({ source: { available: true, detail: 'test' }, observations: clustered.clusters.flatMap((cluster) => cluster.members) })
    mocks.clusters.mockResolvedValue({ ok: true, response: clustered })

    await act(async () => root.render(<AgentWasteReviewPage />))
    const clusterButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cluster similar reports')
    await act(async () => clusterButton?.click())
    const removeButton = host.querySelector<HTMLButtonElement>('#cluster-remove-0-0')
    expect(removeButton).not.toBeNull()

    await act(async () => removeButton?.click())
    expect(host.textContent).toContain('1 report')
    expect(host.textContent).toContain('aggregate 500 tok')
    const undoButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Undo')
    expect(document.activeElement).toBe(undoButton)
    await act(async () => undoButton?.click())

    const cards = [...host.querySelectorAll('.agent-waste-cluster-card')]
    expect(cards.map((card) => card.querySelector('strong')?.textContent)).toEqual(['First', 'Second'])
    expect(cards[0]?.textContent).toContain('2 reports')
    expect(cards[0]?.textContent).toContain('aggregate 1,000 tok')
    expect(host.querySelectorAll('[aria-label^="Remove duplicate report"]').length).toBe(2)
    expect(document.activeElement).toBe(host.querySelector('#cluster-remove-0-0'))
    expect(mocks.backlog).toHaveBeenCalledTimes(1)
    expect(mocks.clusters).toHaveBeenCalledTimes(1)
  })
})
