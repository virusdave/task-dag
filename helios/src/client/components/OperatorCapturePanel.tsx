import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  OPERATOR_CAPTURE_MAX_BYTES,
  OPERATOR_CAPTURE_MAX_PIXELS,
  OperatorCaptureKeySchema,
  OperatorCaptureMetadataSchema,
  OperatorCaptureResponseSchema,
  OperatorCaptureTargetSchema,
  parseOperatorCaptureRedirect,
  type OperatorCaptureResponse,
  type OperatorCaptureTarget,
  type OperatorCaptureMetadata,
} from '../../shared/contracts/index.js'
import { buildAppPath } from '../app/paths.js'

const CAPTURE_PARAMS = ['capture', 'captureTarget', 'captureName', 'captureKey', 'captureRedirect'] as const
const CAPTURE_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/u
const STORAGE_PREFIX = 'helios.operatorCapture.success.'
const REDIRECT_SECONDS = 5

export type OperatorCaptureQuery = {
  captureKey: string
  captureName: string
  redirectUrl: string
  target: OperatorCaptureTarget
}

export type OperatorCaptureQueryResult =
  | { mode: 'off' }
  | { mode: 'invalid'; message: string }
  | { mode: 'capture'; value: OperatorCaptureQuery }

export function parseOperatorCaptureQuery(search: string): OperatorCaptureQueryResult {
  const params = new URLSearchParams(search)
  const captureLike = [...params.keys()].filter((key) => key.startsWith('capture'))
  if (captureLike.length === 0) return { mode: 'off' }
  const unknown = captureLike.find((key) => !CAPTURE_PARAMS.includes(key as (typeof CAPTURE_PARAMS)[number]))
  if (unknown) return { mode: 'invalid', message: `Unknown capture parameter: ${unknown}` }
  for (const key of CAPTURE_PARAMS) {
    if (params.getAll(key).length !== 1) {
      return { mode: 'invalid', message: `Capture parameter ${key} must appear exactly once.` }
    }
  }
  if (params.get('capture') !== '1') return { mode: 'invalid', message: 'Capture mode must be capture=1.' }
  const target = OperatorCaptureTargetSchema.safeParse(params.get('captureTarget'))
  const captureKey = OperatorCaptureKeySchema.safeParse(params.get('captureKey'))
  const captureName = params.get('captureName') ?? ''
  const redirectUrl = parseOperatorCaptureRedirect(params.get('captureRedirect') ?? '')
  if (!target.success) return { mode: 'invalid', message: 'Capture target is not supported.' }
  if (!CAPTURE_NAME.test(captureName)) return { mode: 'invalid', message: 'Capture name must be a lowercase slug of at most 80 characters.' }
  if (!captureKey.success) return { mode: 'invalid', message: 'Capture key is invalid.' }
  if (redirectUrl === null) return { mode: 'invalid', message: 'Capture redirect is not an allowed GitHub issue URL.' }
  return { mode: 'capture', value: { captureKey: captureKey.data, captureName, redirectUrl, target: target.data } }
}

function pageUrlWithoutCaptureParams(): string {
  const url = new URL(window.location.href)
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('capture')) url.searchParams.delete(key)
  }
  return url.toString()
}

function recoveredCapture(key: string, redirectUrl: string): OperatorCaptureResponse | null {
  const storageKey = `${STORAGE_PREFIX}${key}`
  let raw: string | null
  try {
    raw = window.localStorage.getItem(storageKey)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const response = OperatorCaptureResponseSchema.safeParse(parsed)
    if (
      response.success &&
      response.data.captureId === key &&
      response.data.redirectUrl === redirectUrl &&
      new Date(response.data.expiresAt).getTime() > Date.now() &&
      isPinnedCaptureUrl(response.data.reviewUrl, response.data.directUrl)
    ) {
      return response.data
    }
  } catch {
    // Invalid browser storage is discarded below.
  }
  try {
    window.localStorage.removeItem(storageKey)
  } catch {
    // Storage may be disabled; the invalid record is harmless if inaccessible.
  }
  return null
}

function isPinnedCaptureUrl(reviewUrl: string, directUrl: string): boolean {
  const match = /^https:\/\/vpn-helios\.freshlybaked\.us\/one-offs\/([A-Za-z0-9_-]{24,128})\/$/u.exec(reviewUrl)
  return match !== null && directUrl === `${reviewUrl}capture.png`
}

export function OperatorCapturePanel() {
  const query = useMemo(() => parseOperatorCaptureQuery(window.location.search), [])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OperatorCaptureResponse | null>(() =>
    query.mode === 'capture' ? recoveredCapture(query.value.captureKey, query.value.redirectUrl) : null,
  )
  const [pending, setPending] = useState<{ blob: Blob; metadata: OperatorCaptureMetadata } | null>(null)
  const [clipboardFailed, setClipboardFailed] = useState(false)
  const [seconds, setSeconds] = useState(REDIRECT_SECONDS)
  const [copyConfirmed, setCopyConfirmed] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [canRetrySmaller, setCanRetrySmaller] = useState(false)

  useEffect(() => {
    if (query.mode !== 'capture' || result !== null) return
    const selector = `[data-helios-capture-target="${query.value.target}"]`
    const evaluate = () => setReady(document.querySelector(selector)?.getAttribute('data-helios-capture-ready') === 'true')
    evaluate()
    const observer = new MutationObserver(evaluate)
    observer.observe(document.body, { attributes: true, childList: true, subtree: true })
    return () => observer.disconnect()
  }, [query, result])

  useEffect(() => {
    if (result === null || !copyConfirmed || !redirecting) return
    setSeconds(REDIRECT_SECONDS)
    const interval = window.setInterval(() => setSeconds((current) => Math.max(0, current - 1)), 1000)
    const timeout = window.setTimeout(() => window.location.assign(result.redirectUrl), REDIRECT_SECONDS * 1000)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(timeout)
    }
  }, [copyConfirmed, redirecting, result])

  const capture = useCallback(async (scale = 1) => {
    if (query.mode !== 'capture') return
    setBusy(true)
    setError(null)
    setCanRetrySmaller(false)
    try {
      let artifact = pending
      if (artifact === null) {
        const targets = document.querySelectorAll<HTMLElement>(`[data-helios-capture-target="${query.value.target}"]`)
        if (targets.length !== 1 || targets[0]?.dataset.heliosCaptureReady !== 'true') {
          throw new Error('The capture target is not uniquely ready.')
        }
        const target = targets[0]
        const rect = await settleCaptureTarget(target)
        if (rect.width * rect.height * scale * scale > OPERATOR_CAPTURE_MAX_PIXELS) {
          setCanRetrySmaller(scale === 1)
          throw new Error('This page is too large to capture at full resolution.')
        }
        const { toBlob } = await import('html-to-image')
        const blob = await toBlob(target, { pixelRatio: scale, cacheBust: true })
        if (blob === null || blob.type !== 'image/png') {
          throw new Error('The browser could not produce a valid PNG.')
        }
        if (blob.size > OPERATOR_CAPTURE_MAX_BYTES) {
          setCanRetrySmaller(scale === 1)
          throw new Error('The capture exceeds 100 MB at full resolution.')
        }
        const metadata = OperatorCaptureMetadataSchema.parse({
          capturedAt: new Date().toISOString(),
          devicePixelRatio: scale,
          height: rect.height,
          pageUrl: pageUrlWithoutCaptureParams(),
          renderer: 'html-to-image@1.11.13',
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          width: rect.width,
        })
        artifact = { blob, metadata }
        setPending(artifact)
      }
      const body = new FormData()
      body.set('captureKey', query.value.captureKey)
      body.set('captureName', query.value.captureName)
      body.set('redirectUrl', query.value.redirectUrl)
      body.set('metadata', JSON.stringify(artifact.metadata))
      body.set('capture', artifact.blob, `${query.value.captureName}.png`)
      const response = await fetch(buildAppPath('/api/operator-captures'), { method: 'POST', body, credentials: 'same-origin' })
      if (!response.ok) {
        const uploadError = await captureUploadError(response)
        if (uploadError.canRetrySmaller) {
          setPending(null)
          setCanRetrySmaller(true)
        }
        throw new Error(uploadError.message)
      }
      const payload = OperatorCaptureResponseSchema.parse(await response.json())
      setPending(null)
      setResult(payload)
      try {
        window.localStorage.setItem(`${STORAGE_PREFIX}${query.value.captureKey}`, JSON.stringify(payload))
      } catch {
        // The in-memory result remains usable when browser storage is full or disabled.
      }
      try {
        await navigator.clipboard.writeText(payload.directUrl)
        setCopyConfirmed(true)
        setRedirecting(true)
      } catch {
        setClipboardFailed(true)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Capture failed.')
    } finally {
      setBusy(false)
    }
  }, [pending, query])

  const copyAndContinue = useCallback(async () => {
    if (result === null) return
    try {
      await navigator.clipboard.writeText(result.directUrl)
      setClipboardFailed(false)
      setCopyConfirmed(true)
      setRedirecting(true)
    } catch {
      setClipboardFailed(true)
      setRedirecting(false)
    }
  }, [result])

  if (query.mode === 'off') return null
  if (query.mode === 'invalid') {
    return <aside className="operator-capture-panel operator-capture-panel--invalid" role="dialog" aria-label="Invalid capture link"><strong>Invalid capture link</strong><span>{query.message}</span></aside>
  }
  return (
    <aside className="operator-capture-panel" role="dialog" aria-label="Operator capture">
      <div className="operator-capture-status">
        <strong>{result ? copyConfirmed ? 'Capture ready' : 'Copy the image link' : busy ? 'Capturing...' : ready ? 'Ready to capture' : 'Waiting for page...'}</strong>
        {result ? <span>{redirecting ? `Returning to GitHub in ${seconds} seconds.` : 'The capture is safely stored. No redirect is running.'}</span> : <span>{query.value.captureName}</span>}
        {error ? <span className="operator-capture-error">{error}</span> : null}
        {clipboardFailed && result ? <label>Copy image URL<input readOnly value={result.directUrl} onFocus={(event) => event.currentTarget.select()} /></label> : null}
      </div>
      <div className="operator-capture-actions">
        {result ? (
          copyConfirmed ? <a className="primary-button like-button" href={result.directUrl} target="_blank" rel="noreferrer">Open image</a> : <button className="primary-button" type="button" onClick={() => void copyAndContinue()}>Copy link &amp; continue</button>
        ) : <button className="primary-button" type="button" disabled={!ready || busy} onClick={() => void capture()}>{pending ? 'Retry upload' : 'Capture & upload'}</button>}
        {canRetrySmaller && !result ? <button className="primary-button" type="button" disabled={busy} onClick={() => void capture(0.5)}>Capture smaller image</button> : null}
        {result && copyConfirmed && redirecting ? (
          <button type="button" className="ghost-button" onClick={() => setRedirecting(false)}>Stay here</button>
        ) : (
          <button type="button" className="ghost-button" onClick={() => window.location.assign(result?.redirectUrl ?? query.value.redirectUrl)}>Return to task</button>
        )}
      </div>
    </aside>
  )
}

async function captureUploadError(response: Response): Promise<{ canRetrySmaller: boolean; message: string }> {
  let detail = ''
  try {
    const payload = await response.json() as { error?: unknown }
    if (typeof payload.error === 'string') detail = payload.error
  } catch {
    // Fall back to the status-specific guidance below.
  }
  const canRetrySmaller = response.status === 413 || /too large|size|dimension/iu.test(detail)
  if (canRetrySmaller) {
    return { canRetrySmaller, message: detail || 'The capture is too large to upload. Try a smaller image.' }
  }
  return { canRetrySmaller, message: detail || `Upload failed with status ${response.status}. Try again.` }
}

async function settleCaptureTarget(target: HTMLElement): Promise<{ height: number; width: number }> {
  await document.fonts?.ready
  await Promise.all([...target.querySelectorAll('img')].map(async (image) => {
    if (image.complete) return
    await Promise.race([
      image.decode().catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, 3_000)),
    ])
  }))
  await nextFrame()
  const first = roundedDimensions(target)
  await nextFrame()
  const second = roundedDimensions(target)
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('The page is still changing. Try again in a moment.')
  }
  return second
}

function roundedDimensions(target: HTMLElement): { height: number; width: number } {
  const rect = target.getBoundingClientRect()
  return { height: Math.max(1, Math.round(rect.height)), width: Math.max(1, Math.round(rect.width)) }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}
