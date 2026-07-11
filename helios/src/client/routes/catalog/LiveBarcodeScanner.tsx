/**
 * Fullscreen live-camera barcode scanner.
 *
 * Why this exists:
 *   The Images & Barcodes flow used to need a tap-snap-confirm loop
 *   for every barcode read. This component scans the live video stream
 *   so the operator gets immediate feedback and auto-grab without
 *   manual capture.
 *
 * Defensive choices made because earlier implementations rendered as
 * a 4-screens-tall pane that never showed video, or showed nothing at
 * all on iOS:
 *
 *   * The overlay is rendered via React Portal to `document.body`
 *     instead of inline in the catalog tree, so an ancestor with
 *     `transform` / `filter` / `will-change` (any of which break
 *     `position: fixed`) cannot affect us.
 *   * Width/height are pinned in pixels via `window.innerWidth/Height`
 *     plus `100vw`/`100dvh` fallbacks, so a flex parent can't blow
 *     the box up to multiple screen heights even if the portal step
 *     ever fails.
 *   * The scanner does **not** auto-start in `useEffect`. The previous
 *     version did, which had two problems:
 *       1. Inline `onDetected` callbacks from the parent meant the
 *          effect re-fired every parent render, tearing down and
 *          re-acquiring the camera mid-stream.
 *       2. On iOS Safari, `video.play()` after `await getUserMedia(...)`
 *          falls outside the user-gesture chain and silently rejects,
 *          leaving a black preview with no recovery path.
 *     Instead we render a "Tap to start camera" button inside the
 *     portal. The first tap is a guaranteed user-gesture context, so
 *     iOS will let `video.play()` run.
 *   * `onDetected` / `onCancel` are stashed in refs so parent
 *     re-renders never restart scanner lifecycle.
 *   * A visible stage chip (`Requesting camera… / Starting decoder…
 *     / Active`) sits on top of the video so when something fails we
 *     can see which step failed instead of staring at a black box.
 *   * We own the MediaStream ourselves via `getUserMedia`, attach it
 *     to the <video> element, call `video.play()` (which Safari
 *     requires for `playsInline+muted` to actually display frames),
 *     and only then ask `@zxing/browser` to decode against the
 *     already-running <video>. This avoids the
 *     `decodeFromConstraints` race where the camera setup can hang
 *     silently when the host page has a complex flex layout.
 *   * Teardown stops every MediaStreamTrack and clears `srcObject`
 *     so the camera light goes off even on close/unmount/route-change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { importChunkOrReload } from '../../app/dynamicImport.js'

interface Props {
  open: boolean
  onDetected: (value: string) => void
  onCancel: () => void
  onPickPhoto?: () => void
}

interface DetectionOverlay {
  // Polyline points in CSS pixels relative to the overlay canvas.
  points: Array<{ x: number; y: number }>
  value: string
}

type ScannerStage = 'idle' | 'requesting' | 'starting' | 'active' | 'error'

interface NativeDetectedBarcode {
  rawValue?: string
  cornerPoints?: Array<{ x: number; y: number }>
}

interface NativeBarcodeDetectorInstance {
  detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<NativeDetectedBarcode[]>
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: string[] }): NativeBarcodeDetectorInstance
  getSupportedFormats?: () => Promise<string[]>
}

interface BarcodeImageDetectionResult {
  rawValue?: string
}

interface BarcodeImageDetectorCtor {
  new (options?: { formats?: string[] }): {
    detect: (source: CanvasImageSource | ImageBitmap | Blob | ImageData) => Promise<BarcodeImageDetectionResult[]>
  }
}

/**
 * Canonical still-photo fallback shared by every Helios package scanner.
 * Native BarcodeDetector gets the fast path; the lazy zxing decoder gets a
 * second chance for glare, blur, and tight aisle photos.
 */
export async function decodeBarcodeFromImageFile(file: File): Promise<string | null> {
  const native = await tryNativeBarcodeDetector(file)
  if (native !== null && native.length > 0) return native
  const zxing = await tryZxingDecode(file)
  return zxing !== null && zxing.length > 0 ? zxing : null
}

async function tryNativeBarcodeDetector(file: File): Promise<string | null> {
  const Detector = (
    window as unknown as { BarcodeDetector?: BarcodeImageDetectorCtor }
  ).BarcodeDetector
  if (!Detector) return null
  let bitmap: ImageBitmap | null = null
  try {
    const detector = new Detector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'],
    })
    bitmap = await createImageBitmap(file)
    const detections = await detector.detect(bitmap)
    return detections[0]?.rawValue?.trim() ?? null
  } catch (error) {
    console.warn('[barcode-scan] native BarcodeDetector threw, falling back to zxing', error)
    return null
  } finally {
    bitmap?.close?.()
  }
}

async function tryZxingDecode(file: File): Promise<string | null> {
  const { BrowserMultiFormatReader } = await importChunkOrReload(
    () => import('@zxing/browser'),
    '@zxing/browser (tryZxingDecode)',
  )
  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Failed to load image for barcode decode.'))
      image.src = objectUrl
    })
    const reader = new BrowserMultiFormatReader()
    try {
      const result = await reader.decodeFromImageElement(image)
      return result.getText().trim()
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? ''
      if (name !== 'NotFoundException' && name !== 'NotFoundException2') {
        console.warn('[barcode-scan] zxing decoder threw', error)
      }
      return null
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function LiveBarcodeScanner({ open, onDetected, onCancel, onPickPhoto }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)

  // Latched once we detect a real value so the rAF overlay loop can
  // keep painting the green box for ~350 ms before we tear down.
  const lockedRef = useRef<boolean>(false)
  // Most recent detection. Painted by the rAF loop. Cleared after
  // commit.
  const detectionRef = useRef<DetectionOverlay | null>(null)

  // Camera/decoder lifecycle owned by refs, NOT by `useEffect`
  // closures, so parent re-renders cannot tear it down.
  const streamRef = useRef<MediaStream | null>(null)
  const controlsStopRef = useRef<(() => void) | null>(null)
  const rafHandleRef = useRef<number | null>(null)
  const detectionTimeoutRef = useRef<number | null>(null)
  const startBusyRef = useRef<boolean>(false)
  const lifecycleTokenRef = useRef(0)

  // Keep the latest callbacks reachable from async paths without
  // forcing the effect/start handler to re-run on prop churn.
  const onDetectedRef = useRef(onDetected)
  const onCancelRef = useRef(onCancel)
  const onPickPhotoRef = useRef(onPickPhoto)
  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])
  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])
  useEffect(() => {
    onPickPhotoRef.current = onPickPhoto
  }, [onPickPhoto])

  const [stage, setStage] = useState<ScannerStage>('idle')
  const [status, setStatus] = useState<string>('Tap to start camera')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const tearDown = useCallback(() => {
    lifecycleTokenRef.current += 1
    startBusyRef.current = false
    if (detectionTimeoutRef.current !== null) {
      window.clearTimeout(detectionTimeoutRef.current)
      detectionTimeoutRef.current = null
    }
    if (controlsStopRef.current) {
      try {
        controlsStopRef.current()
      } catch {
        /* noop */
      }
      controlsStopRef.current = null
    }
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current)
      rafHandleRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop()
        } catch {
          /* noop */
        }
      }
      streamRef.current = null
    }
    const v = videoRef.current
    if (v) {
      try {
        v.pause()
      } catch {
        /* noop */
      }
      try {
        v.srcObject = null
      } catch {
        /* noop */
      }
    }
  }, [])

  // Reset/teardown only — never auto-starts the camera.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    lockedRef.current = false
    detectionRef.current = null
    setStage('idle')
    setStatus('Tap to start camera')
    setErrorMessage(null)
    window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    })
    return () => {
      tearDown()
      document.body.style.overflow = previousOverflow
      opener?.focus()
    }
  }, [open, tearDown])

  const handleDialogKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      tearDown()
      onCancelRef.current()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [tearDown])

  const runRafLoop = useCallback(() => {
    const paint = () => {
      const overlay = overlayRef.current
      const video = videoRef.current
      if (overlay && video) {
        const dpr = window.devicePixelRatio || 1
        const cssWidth = overlay.clientWidth
        const cssHeight = overlay.clientHeight
        const desiredW = Math.max(1, Math.floor(cssWidth * dpr))
        const desiredH = Math.max(1, Math.floor(cssHeight * dpr))
        if (overlay.width !== desiredW) overlay.width = desiredW
        if (overlay.height !== desiredH) overlay.height = desiredH
        const ctx = overlay.getContext('2d')
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, cssWidth, cssHeight)
          const detection = detectionRef.current
          if (detection && detection.points.length > 0) {
            ctx.lineWidth = 4
            ctx.strokeStyle = lockedRef.current ? '#1ad81a' : '#ffcc00'
            ctx.fillStyle = lockedRef.current
              ? 'rgba(26, 216, 26, 0.18)'
              : 'rgba(255, 204, 0, 0.18)'
            const pts = detection.points
            const xs = pts.map((p) => p.x)
            const ys = pts.map((p) => p.y)
            if (pts.length >= 3) {
              ctx.beginPath()
              ctx.moveTo(pts[0].x, pts[0].y)
              for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y)
              ctx.closePath()
              ctx.fill()
              ctx.stroke()
            } else {
              const minX = Math.min(...xs)
              const maxX = Math.max(...xs)
              const minY = Math.min(...ys)
              const maxY = Math.max(...ys)
              const padX = 8
              const padY = 36
              const rectX = Math.max(0, minX - padX)
              const rectY = Math.max(0, minY - padY)
              const rectW = Math.min(cssWidth - rectX, maxX - minX + padX * 2)
              const rectH = Math.min(cssHeight - rectY, maxY - minY + padY * 2)
              ctx.fillRect(rectX, rectY, rectW, rectH)
              ctx.strokeRect(rectX, rectY, rectW, rectH)
            }
          }
        }
      }
      rafHandleRef.current = window.requestAnimationFrame(paint)
    }
    if (rafHandleRef.current !== null) cancelAnimationFrame(rafHandleRef.current)
    rafHandleRef.current = window.requestAnimationFrame(paint)
  }, [])

  const handleStartCamera = useCallback(async () => {
    if (startBusyRef.current) return
    const video = videoRef.current
    if (!video) {
      setStage('error')
      setErrorMessage('Scanner UI not ready yet. Close and reopen, then try again.')
      return
    }
    startBusyRef.current = true
    const lifecycleToken = ++lifecycleTokenRef.current
    lockedRef.current = false
    detectionRef.current = null
    setErrorMessage(null)
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia is not available in this browser')
      }

      // 1) Acquire the camera ourselves. Two-step fallback: prefer
      // the rear camera but accept any camera if the device has no
      // back-facing one.
      setStage('requesting')
      setStatus('Requesting camera…')
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
      } catch (primaryErr) {
        if (lifecycleToken !== lifecycleTokenRef.current) return
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true })
        // eslint-disable-next-line no-console
        console.warn('[live-barcode-scanner] rear camera unavailable, using default', primaryErr)
      }

      if (lifecycleToken !== lifecycleTokenRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }

      streamRef.current = stream

      // 2) Attach the stream to the <video> and start playback.
      // Safari/iOS will NOT render frames unless we call .play()
      // explicitly after setting srcObject — even with autoplay,
      // muted, and playsInline already on the element. Because this
      // path is reached from a button click inside the portal (not
      // an effect), we are still in user-gesture context.
      video.srcObject = stream
      video.muted = true
      ;(video as HTMLVideoElement & { playsInline: boolean }).playsInline = true
      setStage('starting')
      setStatus('Starting decoder…')
      await video.play()
      if (lifecycleToken !== lifecycleTokenRef.current) return

      runRafLoop()

      // 3) Decode against the already-running video. We prefer the
      // browser's native BarcodeDetector when available (Android
      // Chrome) because it's significantly more accurate and faster
      // than @zxing/browser on mobile. Fall back to zxing on iOS /
      // desktop browsers that don't ship BarcodeDetector.
      const productFormats = [
        'upc_a',
        'upc_e',
        'ean_13',
        'ean_8',
        'code_128',
        'code_39',
        'code_93',
        'codabar',
        'itf',
        'qr_code',
        'data_matrix',
      ]
      const handleDecodedValue = (value: string, points: Array<{ x: number; y: number }>) => {
        if (lifecycleToken !== lifecycleTokenRef.current) return
        if (lockedRef.current) return
        if (value.length === 0) return
        detectionRef.current = { points, value }
        lockedRef.current = true
        setStatus(`✓ ${value}`)
        playConfirmBeep()
        detectionTimeoutRef.current = window.setTimeout(() => {
          detectionTimeoutRef.current = null
          onDetectedRef.current(value)
        }, 350)
      }
      const nativeDetectorCtor = (
        window as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor }
      ).BarcodeDetector
      if (nativeDetectorCtor) {
        // Prefer native: usually backed by Google's library on Android
        // and Vision framework on macOS — much more accurate than
        // zxing.
        let nativeFormats: string[] = productFormats
        try {
          const supported = (await nativeDetectorCtor.getSupportedFormats?.()) ?? []
          if (lifecycleToken !== lifecycleTokenRef.current) return
          if (supported.length > 0) {
            const supportedSet = new Set(supported)
            const filtered = productFormats.filter((f) => supportedSet.has(f))
            if (filtered.length > 0) nativeFormats = filtered
          }
        } catch {
          /* getSupportedFormats is optional; ignore */
        }
        if (lifecycleToken !== lifecycleTokenRef.current) return
        const detector = new nativeDetectorCtor({ formats: nativeFormats })
        let nativeRunning = true
        controlsStopRef.current = () => {
          nativeRunning = false
        }
        const tick = async () => {
          if (!nativeRunning || lockedRef.current) return
          const videoNow = videoRef.current
          const overlayNow = overlayRef.current
          if (!videoNow || !overlayNow) {
            window.setTimeout(tick, 150)
            return
          }
          if (videoNow.readyState < 2 || videoNow.videoWidth === 0) {
            window.setTimeout(tick, 150)
            return
          }
          try {
            const detections = await detector.detect(videoNow)
            if (!nativeRunning || lockedRef.current) return
            if (detections.length === 0) {
              detectionRef.current = null
            } else {
              const best = detections[0]
              const corners = best.cornerPoints ?? []
              const mapped = mapPlainPointsToOverlay(
                corners,
                videoNow.videoWidth,
                videoNow.videoHeight,
                overlayNow.clientWidth,
                overlayNow.clientHeight,
              )
              const value = (best.rawValue ?? '').trim()
              if (value.length > 0) handleDecodedValue(value, mapped)
            }
          } catch (err) {
            // Native detector can throw on partial frames; just skip.
            // eslint-disable-next-line no-console
            console.debug('[live-barcode-scanner] native detect tick failed', err)
          }
          if (nativeRunning && !lockedRef.current) {
            window.setTimeout(tick, 120)
          }
        }
        void tick()
      } else {
        const { BrowserMultiFormatReader } = await importChunkOrReload(
          () => import('@zxing/browser'),
          '@zxing/browser (LiveBarcodeScanner)',
        )
        if (lifecycleToken !== lifecycleTokenRef.current) return
        const { BarcodeFormat, DecodeHintType } = await importChunkOrReload(
          () => import('@zxing/library'),
          '@zxing/library (LiveBarcodeScanner)',
        )
        if (lifecycleToken !== lifecycleTokenRef.current) return
        const zxingFormats = [
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.CODE_93,
          BarcodeFormat.CODABAR,
          BarcodeFormat.ITF,
          BarcodeFormat.QR_CODE,
          BarcodeFormat.DATA_MATRIX,
        ]
        // Enum is dynamically imported, so we can't use it as a type
        // here. It's a numeric enum, so `number` is the right key type.
        const hints = new Map<number, unknown>()
        // TRY_HARDER costs CPU but dramatically improves hit rate on
        // imperfect frames — exactly what we want when waving a phone
        // at a product label.
        hints.set(DecodeHintType.TRY_HARDER, true)
        hints.set(DecodeHintType.POSSIBLE_FORMATS, zxingFormats)
        const reader = new BrowserMultiFormatReader(hints, {
          // Default is 500ms — too slow when the operator is briefly
          // holding the phone steady. 120ms gives ~8 scan attempts/s
          // which is what the rest of the UI assumes.
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: 250,
        })
        const controls = await reader.decodeFromVideoElement(video, (result, _err) => {
          if (lockedRef.current) return
          const videoNow = videoRef.current
          const overlayNow = overlayRef.current
          if (!videoNow || !overlayNow) return
          if (!result) {
            detectionRef.current = null
            return
          }
          const value = result.getText().trim()
          const points = mapResultPointsToOverlay(
            result.getResultPoints(),
            videoNow.videoWidth,
            videoNow.videoHeight,
            overlayNow.clientWidth,
            overlayNow.clientHeight,
          )
          handleDecodedValue(value, points)
        })
        if (lifecycleToken !== lifecycleTokenRef.current) {
          controls.stop()
          return
        }
        controlsStopRef.current = () => controls.stop()
      }

      if (lifecycleToken !== lifecycleTokenRef.current) return
      setStage('active')
      setStatus('Point the camera at a barcode…')
    } catch (error) {
      if (lifecycleToken !== lifecycleTokenRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn('[live-barcode-scanner] camera/decoder failed', error)
      setStage('error')
      setStatus('Tap to start camera')
      setErrorMessage(humanizeCameraError(message))
      tearDown()
    } finally {
      if (lifecycleToken === lifecycleTokenRef.current) startBusyRef.current = false
    }
  }, [runRafLoop, tearDown])

  if (!open) return null
  if (typeof document === 'undefined') return null

  // Pin the dialog to the viewport via pixel dimensions in addition
  // to `inset: 0` + `100dvh` — belt-and-suspenders against the prior
  // "4 screens tall" regression where an ancestor layout context
  // was capable of disturbing position:fixed.
  const vw = typeof window !== 'undefined' ? `${window.innerWidth}px` : '100vw'
  const vh = typeof window !== 'undefined' ? `${window.innerHeight}px` : '100dvh'

  const stageLabel =
    stage === 'requesting'
      ? 'Requesting camera…'
      : stage === 'starting'
        ? 'Starting decoder…'
        : stage === 'active'
          ? 'Active'
          : stage === 'error'
            ? 'Error'
            : 'Idle'

  const ctaLabel =
    stage === 'error'
      ? 'Tap to try camera again'
      : stage === 'requesting' || stage === 'starting'
        ? 'Starting…'
        : 'Tap to start camera'

  const overlay = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Live barcode scanner"
      onKeyDown={handleDialogKeyDown}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: vw,
        height: vh,
        maxWidth: '100vw',
        maxHeight: '100dvh',
        zIndex: 2147483000,
        background: 'rgba(0, 0, 0, 0.95)',
        display: 'flex',
        flexDirection: 'column',
        color: '#fff',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          gap: '0.5rem',
          flex: '0 0 auto',
        }}
      >
        <strong style={{ fontSize: '1rem' }}>Scan barcode</strong>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            tearDown()
            onCancelRef.current()
          }}
          style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
        >
          ✕ Close
        </button>
      </div>
      <div
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'hidden',
          background: '#000',
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            background: '#000',
          }}
        />
        <canvas
          ref={overlayRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            zIndex: 3,
            padding: '0.35rem 0.6rem',
            borderRadius: 999,
            background: 'rgba(0, 0, 0, 0.72)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 600,
            letterSpacing: '0.02em',
            pointerEvents: 'none',
          }}
        >
          {stageLabel}
        </div>
        {stage !== 'active' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
              background: 'rgba(0, 0, 0, 0.55)',
            }}
          >
            <button
              type="button"
              onClick={() => void handleStartCamera()}
              disabled={stage === 'requesting' || stage === 'starting'}
              style={{
                padding: '0.9rem 1.4rem',
                borderRadius: 12,
                border: '1px solid rgba(255, 255, 255, 0.28)',
                background: 'rgba(0, 0, 0, 0.72)',
                color: '#fff',
                fontSize: '1rem',
                fontWeight: 600,
                cursor:
                  stage === 'requesting' || stage === 'starting' ? 'progress' : 'pointer',
              }}
            >
              {ctaLabel}
            </button>
          </div>
        ) : null}
      </div>
      <div
        style={{
          padding: '0.75rem 1rem',
          textAlign: 'center',
          background: 'rgba(0,0,0,0.6)',
          minHeight: '2.5rem',
          flex: '0 0 auto',
        }}
      >
        {errorMessage ? (
          <div role="alert" style={{ display: 'grid', justifyItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: '#ff7a7a' }}>{errorMessage}</span>
            {onPickPhotoRef.current ? (
              <button
                type="button"
                className="ghost-button"
                style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
                onClick={() => {
                  tearDown()
                  onPickPhotoRef.current?.()
                }}
              >
                Use a photo instead
              </button>
            ) : null}
          </div>
        ) : (
          <span role="status" aria-live="polite">{status}</span>
        )}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

/**
 * Convert zxing's ResultPoint[] (in video-pixel coordinates) into the
 * overlay-canvas CSS-pixel coordinates, accounting for the
 * `object-fit: cover` cropping the browser does to fit the video into
 * the (likely portrait) overlay box.
 */
function mapResultPointsToOverlay(
  points: ReadonlyArray<{ getX(): number; getY(): number }>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Array<{ x: number; y: number }> {
  return mapPointsToOverlay(
    points.map((p) => ({ x: p.getX(), y: p.getY() })),
    srcWidth,
    srcHeight,
    dstWidth,
    dstHeight,
  )
}

/**
 * Same as mapResultPointsToOverlay, but for the plain {x,y} shape the
 * native BarcodeDetector returns (no getX()/getY() methods).
 */
function mapPlainPointsToOverlay(
  points: ReadonlyArray<{ x: number; y: number }>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Array<{ x: number; y: number }> {
  return mapPointsToOverlay(points, srcWidth, srcHeight, dstWidth, dstHeight)
}

function mapPointsToOverlay(
  points: ReadonlyArray<{ x: number; y: number }>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Array<{ x: number; y: number }> {
  if (srcWidth === 0 || srcHeight === 0 || dstWidth === 0 || dstHeight === 0) {
    return []
  }
  const scale = Math.max(dstWidth / srcWidth, dstHeight / srcHeight)
  const scaledW = srcWidth * scale
  const scaledH = srcHeight * scale
  const offsetX = (dstWidth - scaledW) / 2
  const offsetY = (dstHeight - scaledH) / 2
  return points.map((p) => ({
    x: p.x * scale + offsetX,
    y: p.y * scale + offsetY,
  }))
}

/**
 * Short, polite confirmation beep — same vibe as a supermarket
 * self-checkout scanner. WebAudio so we don't ship an audio asset.
 */
function playConfirmBeep(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.01)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.14)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.16)
    window.setTimeout(() => {
      void ctx.close()
    }, 250)
  } catch {
    // No audio is fine — the green flash is the primary signal.
  }
}

function humanizeCameraError(raw: string): string {
  const lowered = raw.toLowerCase()
  if (lowered.includes('permission') || lowered.includes('notallowed')) {
    return 'Camera permission was denied. Enable camera access for this site, then try again.'
  }
  if (lowered.includes('notfound') || lowered.includes('overconstrained')) {
    return 'No rear camera available on this device. Use the "From photo" fallback.'
  }
  if (lowered.includes('insecure') || lowered.includes('https')) {
    return 'Camera access requires HTTPS.'
  }
  return 'Couldn’t open the camera. Use the "From photo" fallback or reload.'
}
