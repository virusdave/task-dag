// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FORCE_WITHOUT_REVIEW_APPROVAL,
  type AdminPendingMigrationsResponse,
} from '../../../shared/contracts/index.js'
import { HttpResponseError } from '../../app/fetchJson.js'

const mocks = vi.hoisted(() => ({ loadJson: vi.fn(), mutateJson: vi.fn(), loadJobStatus: vi.fn() }))
vi.mock('../../app/fetchJson.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/fetchJson.js')>(),
  loadJson: mocks.loadJson,
  mutateJson: mocks.mutateJson,
}))
vi.mock('../../app/jobPolling.js', () => ({
  loadJobStatus: mocks.loadJobStatus,
  isJobTerminal: () => false,
}))
vi.mock('./configSidebarSubtree.js', () => ({ useRegisterConfigSidebarSubtree: () => undefined }))
vi.mock('react-router-dom', async (original) => ({
  ...await original<typeof import('react-router-dom')>(),
  useRouteLoaderData: () => undefined,
}))

import { PendingMigrationsPage } from './PendingMigrationsPage.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const id = '097_force_test'
const digest = 'a'.repeat(64)
const response: AdminPendingMigrationsResponse = { migrations: [{
  migrationId: id, label: 'force test', sentinelState: 'pending', eligible: false,
  ineligibleReason: 'No blessing', blessing: null, artifactDigestMatch: false,
  artifactSha256: digest, reviewApprovalState: 'missing', forceEligible: true,
  lastAttempt: null,
}] }

function change(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
    bubbles: true,
  }))
}

async function completeForceCeremony(host: HTMLDivElement): Promise<HTMLButtonElement> {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Exceptional action"]')!
  await act(async () => change(select, FORCE_WITHOUT_REVIEW_APPROVAL))
  const idInput = host.querySelector<HTMLInputElement>(
    '[aria-label="Confirm migration ID for exceptional action"]',
  )!
  const phraseInput = host.querySelector<HTMLInputElement>(
    '[aria-label="Confirm exceptional action phrase"]',
  )!
  const checkbox = host.querySelector<HTMLInputElement>(
    '.migration-exceptional-panel input[type="checkbox"]',
  )!
  await act(async () => change(idInput, id))
  await act(async () => change(phraseInput, FORCE_WITHOUT_REVIEW_APPROVAL))
  await act(async () => checkbox.click())
  return [...host.querySelectorAll('button')].find(
    (button) => button.textContent === FORCE_WITHOUT_REVIEW_APPROVAL,
  ) as HTMLButtonElement
}

describe('PendingMigrationsPage exceptional action', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(async () => {
    mocks.loadJson.mockResolvedValue(response)
    mocks.mutateJson.mockResolvedValue({ jobId: 77 })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(<MemoryRouter><PendingMigrationsPage /></MemoryRouter>))
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.clearAllMocks()
  })

  it('requires the isolated exact ceremony, resets on cancel, and submits the bound payload', async () => {
    const details = host.querySelector<HTMLDetailsElement>('.migration-exceptional-action')!
    expect(details.open).toBe(false)
    expect(host.querySelector('.migration-exceptional-panel')).toBeNull()
    const ordinary = host.querySelector<HTMLInputElement>('input[placeholder*="to confirm"]')!
    await act(async () => change(ordinary, id))
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Exceptional action"]',
    )!
    await act(async () => change(select, FORCE_WITHOUT_REVIEW_APPROVAL))
    expect(host.textContent).toContain('Target: Helios production database')
    const forceButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent === FORCE_WITHOUT_REVIEW_APPROVAL,
    ) as HTMLButtonElement
    expect(forceButton.disabled).toBe(true)
    const idInput = host.querySelector<HTMLInputElement>('[aria-label="Confirm migration ID for exceptional action"]')!
    const phraseInput = host.querySelector<HTMLInputElement>('[aria-label="Confirm exceptional action phrase"]')!
    const checkbox = host.querySelector<HTMLInputElement>('.migration-exceptional-panel input[type="checkbox"]')!
    await act(async () => change(idInput, id))
    await act(async () => change(phraseInput, FORCE_WITHOUT_REVIEW_APPROVAL))
    await act(async () => checkbox.click())
    expect(forceButton.disabled).toBe(false)
    await act(async () => ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))?.click())
    expect(host.querySelector('.migration-exceptional-panel')).toBeNull()

    const submit = await completeForceCeremony(host)
    await act(async () => submit.click())
    expect(mocks.mutateJson).toHaveBeenCalledWith(
      `/api/admin/pending-migrations/${id}/force-apply`, expect.anything(),
      expect.objectContaining({ body: JSON.stringify({
        action: FORCE_WITHOUT_REVIEW_APPROVAL,
        confirmationPhrase: FORCE_WITHOUT_REVIEW_APPROVAL,
        target: 'helios-production', confirmMigrationId: id,
        acknowledgedWithoutReview: true, expectedArtifactSha256: digest,
      }) }),
    )
    expect(host.querySelector('.migration-exceptional-panel')).toBeNull()
  })

  it('links the active job when exact dedupe rejects a different request', async () => {
    mocks.mutateJson.mockRejectedValueOnce(new HttpResponseError(
      '409: A different apply request is already active.',
      409,
      { error: 'A different apply request is already active.', existingJobId: 88 },
    ))
    const submit = await completeForceCeremony(host)

    await act(async () => submit.click())

    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.textContent === 'View job #88',
    )
    expect(link?.getAttribute('href')).toBe('/jobs/88')
    expect(host.textContent).toContain('A different apply request is already active.')
  })

  it('discards ceremony state across digest changes, removal, and restoration', async () => {
    await act(async () => change(
      host.querySelector<HTMLSelectElement>('select[aria-label="Exceptional action"]')!,
      FORCE_WITHOUT_REVIEW_APPROVAL,
    ))
    expect(host.querySelector('.migration-exceptional-panel')).not.toBeNull()

    mocks.loadJson.mockResolvedValueOnce({
      migrations: [{ ...response.migrations[0], artifactSha256: 'b'.repeat(64) }],
    })
    const refresh = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refresh',
    )!
    await act(async () => refresh.click())
    expect(host.querySelector('.migration-exceptional-panel')).toBeNull()

    await act(async () => change(
      host.querySelector<HTMLSelectElement>('select[aria-label="Exceptional action"]')!,
      FORCE_WITHOUT_REVIEW_APPROVAL,
    ))
    mocks.loadJson.mockResolvedValueOnce({ migrations: [] })
    await act(async () => refresh.click())
    expect(host.textContent).not.toContain(id)

    mocks.loadJson.mockResolvedValueOnce(response)
    await act(async () => refresh.click())
    expect(host.textContent).toContain(id)
    expect(host.querySelector('.migration-exceptional-panel')).toBeNull()
  })
})
