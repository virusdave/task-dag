// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorCapturePanel, parseOperatorCaptureQuery } from './OperatorCapturePanel.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const toBlob = vi.fn<() => Promise<Blob>>()
vi.mock('html-to-image', () => ({ toBlob }))

const KEY = 'capture_key_1234567890'
const REDIRECT = 'https://github.com/FreshlyBakedNYC/automation/issues/89#issuecomment-123'
const REVIEW = 'https://vpn-helios.freshlybaked.us/one-offs/nonce_123456789012345678901234/'
const SUCCESS = {
  captureId: KEY,
  directUrl: `${REVIEW}capture.png`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  redirectUrl: REDIRECT,
  reviewUrl: REVIEW,
}

function search(overrides: Record<string, string> = {}): string {
  const values = {
    capture: '1',
    captureTarget: 'tasks-overview',
    captureName: 'task-plan',
    captureKey: KEY,
    captureRedirect: REDIRECT,
    ...overrides,
  }
  return `?${new URLSearchParams(values).toString()}`
}

describe('parseOperatorCaptureQuery', () => {
  it('strictly rejects missing, duplicate, unknown, and open redirect parameters', () => {
    expect(parseOperatorCaptureQuery('')).toEqual({ mode: 'off' })
    expect(parseOperatorCaptureQuery('?capture=1')).toMatchObject({ mode: 'invalid' })
    expect(parseOperatorCaptureQuery(`${search()}&captureKey=duplicate_key_12345`)).toMatchObject({ mode: 'invalid' })
    expect(parseOperatorCaptureQuery(`${search()}&captureExtra=1`)).toMatchObject({ mode: 'invalid' })
    expect(parseOperatorCaptureQuery(search({ captureRedirect: 'https://evil.example/steal' }))).toMatchObject({ mode: 'invalid' })
    expect(parseOperatorCaptureQuery(search())).toMatchObject({ mode: 'capture' })
  })
})

describe('OperatorCapturePanel', () => {
  let host: HTMLDivElement
  let root: Root
  const clipboard = vi.fn<(value: string) => Promise<void>>()

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    localStorage.clear()
    toBlob.mockClear()
    clipboard.mockClear()
    toBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    clipboard.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(SUCCESS), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    document.querySelectorAll('[data-helios-capture-target]').forEach((element) => element.remove())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  async function renderPanel(query = search(), ready = true) {
    window.history.replaceState(null, '', `/${query}`)
    if (ready) {
      const target = document.createElement('main')
      target.dataset.heliosCaptureTarget = 'tasks-overview'
      target.dataset.heliosCaptureReady = 'true'
      document.body.append(target)
    }
    await act(async () => root.render(<OperatorCapturePanel />))
    await act(async () => Promise.resolve())
  }

  it('self-gates outside capture mode and disables capture until ready', async () => {
    await renderPanel('', false)
    expect(host.textContent).toBe('')
    await act(async () => root.unmount())
    root = createRoot(host)
    await renderPanel(search(), false)
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  })

  it('captures, uploads, copies the direct URL, and shows the countdown', async () => {
    vi.useFakeTimers()
    await renderPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click())
    await act(async () => Promise.resolve())
    expect(toBlob).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get('captureKey')).toBe(KEY)
    const metadata = JSON.parse(String((body as FormData).get('metadata'))) as { pageUrl: string; renderer: string }
    expect(metadata.pageUrl).not.toContain('capture')
    expect(metadata.renderer).toBe('html-to-image@1.11.13')
    expect(clipboard).toHaveBeenCalledWith(SUCCESS.directUrl)
    expect(host.textContent).toContain('Returning to GitHub in 5 seconds.')
    await act(async () => vi.advanceTimersByTime(1000))
    expect(host.textContent).toContain('Returning to GitHub in 4 seconds.')
    await act(async () => host.querySelector<HTMLButtonElement>('.ghost-button')?.click())
    await act(async () => vi.advanceTimersByTime(10_000))
    expect(host.textContent).toContain('No redirect is running.')
  })

  it('shows a selectable direct URL when clipboard access fails', async () => {
    clipboard.mockRejectedValue(new Error('denied'))
    await renderPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click())
    await act(async () => Promise.resolve())
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe(SUCCESS.directUrl)
    expect(host.textContent).not.toContain('Returning to GitHub')
    expect(host.textContent).toContain('Copy link & continue')
  })

  it('keeps an uploaded result usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota exceeded')
    })
    await renderPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')?.click())
    await act(async () => Promise.resolve())
    expect(host.textContent).toContain('Capture ready')
    expect(clipboard).toHaveBeenCalledWith(SUCCESS.directUrl)
  })

  it('recovers prior success without uploading again', async () => {
    localStorage.setItem(`helios.operatorCapture.success.${KEY}`, JSON.stringify(SUCCESS))
    await renderPanel()
    expect(host.textContent).toContain('Copy the image link')
    expect(host.textContent).not.toContain('Returning to GitHub')
    expect(fetch).not.toHaveBeenCalled()
    expect(toBlob).not.toHaveBeenCalled()
  })

  it('discards expired or redirect-mismatched recovered results', async () => {
    localStorage.setItem(`helios.operatorCapture.success.${KEY}`, JSON.stringify({
      ...SUCCESS,
      expiresAt: '2020-01-01T00:00:00.000Z',
    }))
    await renderPanel()
    expect(host.textContent).toContain('Ready to capture')
    expect(localStorage.getItem(`helios.operatorCapture.success.${KEY}`)).toBeNull()
  })

  it('stays usable when browser storage reads or cleanup are blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new DOMException('storage blocked')
    })
    await renderPanel()
    expect(host.textContent).toContain('Ready to capture')

    await act(async () => root.unmount())
    root = createRoot(host)
    localStorage.setItem(`helios.operatorCapture.success.${KEY}`, JSON.stringify({ ...SUCCESS, expiresAt: '2020-01-01T00:00:00.000Z' }))
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
      throw new DOMException('storage blocked')
    })
    await renderPanel()
    expect(host.textContent).toContain('Ready to capture')
  })
})
