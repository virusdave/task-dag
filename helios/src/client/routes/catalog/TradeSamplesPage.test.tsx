// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobStatusResponse } from '../../../shared/contracts/index.js'

const mocks = vi.hoisted(() => ({ loadJobStatus: vi.fn(), loadJson: vi.fn(), mutateJson: vi.fn() }))

vi.mock('../../app/fetchJson.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/fetchJson.js')>(),
  loadJson: mocks.loadJson,
  mutateJson: mocks.mutateJson,
}))
vi.mock('../../app/jobPolling.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/jobPolling.js')>(),
  loadJobStatus: mocks.loadJobStatus,
}))
vi.mock('./catalogSidebarSubtree.js', () => ({
  useRegisterCatalogSidebarSubtree: () => undefined,
}))

import { TradeSamplesPage } from './TradeSamplesPage.js'
import { TradeSampleStageResults, TradeSampleZeroResults } from '../jobs/JobDetailPage.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function change(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function changeSelect(element: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function jobStatus(
  jobId: number,
  status: JobStatusResponse['job']['status'],
  lastError: string | null = null,
): JobStatusResponse {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'dead_letter'
  return {
    job: {
      attemptCount: 1,
      createdAt: '2026-07-31T06:00:00.000Z',
      executionPool: 'sweed',
      finishedAt: terminal ? '2026-07-31T06:01:00.000Z' : null,
      jobId,
      jobType: 'catalog.inventory.stage_trade_samples',
      lastError,
      module: 'catalog',
      priority: 500,
      priorityBand: 'live_requested',
      requestedByLabel: 'Operator',
      requestedByUserId: 17,
      runAt: '2026-07-31T06:00:00.000Z',
      scope: { entityType: 'trade_sample_site', entityId: '210249' },
      startedAt: '2026-07-31T06:00:01.000Z',
      status,
    },
    linkedRecords: {
      llmRunId: null,
      pendingPurchaseApplyRequestId: null,
      pendingPurchasePacketId: null,
      proposalBatchId: null,
      undoEventId: null,
      writeOperationId: null,
    },
    progressLog: [],
    progress: null,
    sweedAuthEvents: [],
    tradeSampleZeroResult: null,
    tradeSampleStageResult: null,
  }
}

describe('TradeSamplesPage', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    mocks.loadJson.mockResolvedValue({ stageJob: null })
    mocks.loadJobStatus.mockRejectedValue(new Error('status unavailable'))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(<MemoryRouter><TradeSamplesPage /></MemoryRouter>))
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    host.remove()
    vi.clearAllMocks()
  })

  it('binds the destructive confirmation to the exact preview and queues it once', async () => {
    const preview = {
      siteDealerId: 210249,
      digest: 'a'.repeat(64),
      previewId: '123e4567-e89b-42d3-a456-426614174000',
      previewToken: 'signed.preview',
      items: [{
        currentQty: 3.5,
        externalTrackCode: '1A4120300000C1E000064024',
        inventoryItemId: '1656450',
        packageLabel: null,
        productId: 99,
        productName: 'Trade Sample Flower',
        productSku: 'SAMPLE-1',
        availableQty: 3.5,
        sourceLocationId: 12,
        sourceLocationName: 'Back Stock',
        sourceStockTypeId: 3,
      }],
      destination: { id: 88, name: 'NOT FOR SALE - Samples', stockTypeId: 7 },
    }
    mocks.mutateJson.mockResolvedValueOnce(preview).mockResolvedValueOnce({ jobId: 77 })

    const previewButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Preview trade samples',
    )!
    await act(async () => previewButton.click())

    expect(host.textContent).toContain('does not zero inventory')
    expect(host.textContent).toContain('Trade Sample Flower')
    expect(host.textContent).toContain('3.5 total quantity')
    const applyButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Queue staging transfer',
    )!
    expect(applyButton.disabled).toBe(true)

    await act(async () => change(
      host.querySelector<HTMLInputElement>('#trade-sample-confirmation')!,
      'STAGE TRADE SAMPLES',
    ))
    expect(applyButton.disabled).toBe(false)
    await act(async () => applyButton.click())

    expect(mocks.mutateJson).toHaveBeenLastCalledWith(
      '/api/catalog/inventory/trade-samples/apply-zero',
      expect.anything(),
      expect.objectContaining({ body: JSON.stringify({
        siteDealerId: preview.siteDealerId,
        digest: preview.digest,
        previewId: preview.previewId,
        previewToken: preview.previewToken,
        items: preview.items,
        destination: preview.destination,
        confirmation: 'STAGE TRADE SAMPLES',
      }) }),
    )
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/77"]')?.textContent).toBe('Open staging job #77')
    expect(mocks.loadJobStatus).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Reviewed preview')
  })

  it('disarms an ambiguous queue request before it settles and directs the operator to jobs', async () => {
    const preview = {
      siteDealerId: 210249,
      digest: 'a'.repeat(64),
      previewId: '123e4567-e89b-42d3-a456-426614174000',
      previewToken: 'signed.preview',
      items: [{ currentQty: 1, externalTrackCode: 'tag', inventoryItemId: 'item', packageLabel: null,
        productId: 1, productName: 'Sample', productSku: null, availableQty: 1,
        sourceLocationId: 12, sourceLocationName: 'Back Stock', sourceStockTypeId: 3 }],
      destination: { id: 88, name: 'NOT FOR SALE - Samples', stockTypeId: 7 },
    }
    let rejectQueue!: (error: unknown) => void
    const pendingQueue = new Promise((_, reject) => { rejectQueue = reject })
    mocks.mutateJson.mockResolvedValueOnce(preview).mockReturnValueOnce(pendingQueue)
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Preview trade samples')!.click())
    await act(async () => change(host.querySelector<HTMLInputElement>('#trade-sample-confirmation')!, 'STAGE TRADE SAMPLES'))
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Queue staging transfer')!.click())
    expect(host.textContent).not.toContain('Reviewed preview')
    expect(host.textContent).toContain('preview is disarmed')
    expect(mocks.mutateJson).toHaveBeenCalledTimes(2)
    await act(async () => rejectQueue(new Error('network detail')))
    expect(host.textContent).not.toContain('network detail')
    expect(host.textContent).toContain('queue request outcome is unknown')
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs"]')?.textContent).toBe('Check recent jobs')
  })

  it('pauses preview when recent status cannot load and offers status recovery', async () => {
    mocks.loadJson.mockRejectedValueOnce(new Error('offline'))

    await act(async () => changeSelect(host.querySelector<HTMLSelectElement>('#trade-sample-site')!, '210705'))

    const previewButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Preview trade samples',
    )!
    expect(previewButton.disabled).toBe(true)
    expect(host.textContent).toContain('Preview is paused until job status is known')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Retry status')).toBe(true)
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs?jobType=catalog.inventory.stage_trade_samples"]')).not.toBeNull()
  })

  it('keeps the job link through a poll error, then reflects terminal failure and allows a fresh preview', async () => {
    vi.useFakeTimers()
    mocks.loadJson.mockResolvedValueOnce({ stageJob: jobStatus(88, 'running') })
    mocks.loadJobStatus.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(
      jobStatus(88, 'failed', 'Package 44 was not visible after 10 reads.'),
    )

    await act(async () => changeSelect(host.querySelector<HTMLSelectElement>('#trade-sample-site')!, '210705'))
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/88"]')).not.toBeNull()
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Preview trade samples',
    )?.disabled).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(1_500))
    expect(host.textContent).toContain('Status unavailable; retrying automatically')
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/88"]')).not.toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(1_500))
    expect(host.textContent).toContain('Package 44 was not visible after 10 reads.')
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/88"]')?.textContent).toBe('Open staging job #88')
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Create fresh preview',
    )?.disabled).toBe(false)
    vi.useRealTimers()
  })

  it('shows the exact staged scope and reconciles an ambiguous approval without a new action', async () => {
    const staged = {
      operationId: 'stage-8',
      siteDealerId: 210249,
      destination: { id: 88, name: 'NOT FOR SALE - Samples' as const, stockTypeId: 7 },
      items: [{ currentQty: 2, externalTrackCode: 'METRC-TAG', inventoryItemId: 'package-44', packageLabel: null,
        productId: 1, productName: 'Sample', productSku: null, availableQty: 2,
        sourceLocationId: 12, sourceLocationName: 'Back Stock', sourceStockTypeId: 3 }],
      complete: true,
      counts: { completed: 1, failedUnknown: 0, notAppliedStale: 0, notAppliedAuditFailure: 0 },
      outcomes: [{ inventoryItemId: 'package-44', status: 'completed' as const }],
      message: 'Staged and verified.',
    }
    let rejectApproval!: (error: unknown) => void
    mocks.mutateJson.mockReturnValueOnce(new Promise((_, reject) => { rejectApproval = reject }))
      .mockResolvedValueOnce({ jobId: 91 })
    await act(async () => root.render(<MemoryRouter><TradeSampleStageResults jobId={8} result={staged} /></MemoryRouter>))
    expect(host.textContent).toContain('Bronx (dealer #210249)')
    expect(host.textContent).toContain('location #88, stock type #7')
    expect(host.textContent).toContain('Package package-44 · METRC tag METRC-TAG · Qty 2')
    await act(async () => change(host.querySelector<HTMLInputElement>('#stage-approval')!, 'I VERIFIED ONLY TRADE SAMPLES'))
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Approve permanent'))!.click())
    expect(host.textContent).toContain('action is disarmed')
    expect(host.querySelector('#stage-approval')).toBeNull()
    await act(async () => rejectApproval(new Error('network detail')))
    expect(host.textContent).toContain('approval outcome is unknown')
    const reconcile = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check approval outcome')!
    await act(async () => reconcile.click())
    expect(mocks.mutateJson).toHaveBeenCalledTimes(2)
    expect(mocks.mutateJson.mock.calls[0]?.[2]).toEqual(mocks.mutateJson.mock.calls[1]?.[2])
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/91"]')?.textContent).toBe('Open zero job #91')
  })

  it('renders wrapped terminal package outcomes and manual-inspection guidance', async () => {
    await act(async () => root.render(<MemoryRouter><TradeSampleZeroResults result={{
      operationId: 'operation',
      siteDealerId: 210249,
      destination: { id: 88, name: 'NOT FOR SALE - Samples', stockTypeId: 7 },
      items: [{ currentQty: 1, externalTrackCode: 'tag', inventoryItemId: 'very-long-inventory-item-identifier', packageLabel: null,
        productId: 1, productName: 'Sample', productSku: null, availableQty: 1,
        sourceLocationId: 12, sourceLocationName: 'Back Stock', sourceStockTypeId: 3 }],
      stageJobId: 76,
      counts: { completed: 1, failedUnknown: 1, notAppliedStale: 0, notAppliedAuditFailure: 0 },
      outcomes: [{ inventoryItemId: 'very-long-inventory-item-identifier', status: 'failed_unknown' }],
      message: 'Inspect Sweed and create a fresh preview before another adjustment.',
    }} /></MemoryRouter>))
    expect(host.textContent).toContain('Completed: 1')
    expect(host.textContent).toContain('Unknown: 1')
    expect(host.textContent).toContain('Inspect Sweed')
    expect(host.textContent).toContain('Bronx (dealer #210249)')
    expect(host.querySelector<HTMLAnchorElement>('a[href="/jobs/76"]')).not.toBeNull()
    expect(host.querySelector('li')?.style.overflowWrap).toBe('anywhere')
  })
})
