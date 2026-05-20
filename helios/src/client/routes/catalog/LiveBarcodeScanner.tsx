/**
 * Fullscreen live-camera barcode scanner.
 *
 * Why this exists:
 *   The original Images & Barcodes flow used a plain `<input type="file"
 *   capture="environment">` that opened the OS camera, made the
 *   operator snap a still, then ran a one-shot decode on the captured
 *   JPEG. That meant blind aiming, no feedback when the frame was
 *   bad, and a tap-tap-tap loop for every miss. This component runs
 *   the decoder against the live video stream so the operator gets
 *   an immediate red→green box the moment a barcode is in frame and
 *   we auto-grab the value without an extra "use this photo?" tap.
 *
 *   Implementation notes:
 *     * Uses @zxing/browser's `decodeFromConstraints` which wraps the
 *       MediaStream lifecycle for us — we just consume the
 *       (result | error) callback. No manual frame loop; the library
 *       drives it at as many FPS as the device can sustain (CPU
 *       bound; typically 5-15 FPS on phones, which the user said is
 *       fine).
 *     * Bounding box: zxing returns `Result.getResultPoints()`. For
 *       1D barcodes there are typically 2 points (start + end of the
 *       middle horizontal scan line); for 2D it's 3-4 corner points.
 *       We translate from video-pixel coords to overlay-canvas
 *       coords and draw a polyline.
 *     * Confirmation beep: short WebAudio oscillator, 880 Hz, 120 ms.
 *       Falls back to silent if AudioContext is unavailable.
 *     * Rear camera preferred via `facingMode: { ideal: 'environment' }`.
 *     * Cleanup: always call `controls.stop()` on unmount or close
 *       so the camera light doesn't stay on.
 *
 * The component renders inline-styled markup (no new CSS class
 * dependencies) so it can ship without touching the global stylesheet.
 */

import { useEffect, useRef, useState } from 'react'

interface Props {
  open: boolean
  onDetected: (value: string) => void
  onCancel: () => void
}

interface DetectionOverlay {
  // Polyline points in CSS pixels relative to the overlay canvas.
  points: Array<{ x: number; y: number }>
  value: string
}

export function LiveBarcodeScanner({ open, onDetected, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  // Latched once we detect a real value so the rAF overlay loop can
  // keep painting the green box for ~400 ms before we tear down. Held
  // in a ref (not state) because the rAF loop closes over it.
  const lockedRef = useRef<boolean>(false)
  // Most recent detection. Painted by the rAF loop. Cleared after the
  // detection is committed.
  const detectionRef = useRef<DetectionOverlay | null>(null)
  const [status, setStatus] = useState<string>('Requesting camera…')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let controlsStop: (() => void) | null = null
    let rafHandle: number | null = null

    const tearDown = () => {
      if (controlsStop) {
        try {
          controlsStop()
        } catch {
          /* noop */
        }
        controlsStop = null
      }
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
    }

    const runRafLoop = () => {
      const paint = () => {
        if (cancelled) return
        const overlay = overlayRef.current
        const video = videoRef.current
        if (overlay && video) {
          // Resize the overlay backing store to match the on-screen
          // CSS size × devicePixelRatio so lines stay crisp on hi-dpi
          // displays.
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
              ctx.fillStyle = lockedRef.current ? 'rgba(26, 216, 26, 0.18)' : 'rgba(255, 204, 0, 0.18)'
              const pts = detection.points
              const xs = pts.map((p) => p.x)
              const ys = pts.map((p) => p.y)
              if (pts.length >= 3) {
                // 2D barcode (QR / DataMatrix): connect the dots into
                // a polygon.
                ctx.beginPath()
                ctx.moveTo(pts[0].x, pts[0].y)
                for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y)
                ctx.closePath()
                ctx.fill()
                ctx.stroke()
              } else {
                // 1D barcode: zxing gives us the endpoints of the
                // middle scan line. Build a fat rectangle around it
                // so the operator actually sees a "box" highlighting
                // the code.
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
        rafHandle = window.requestAnimationFrame(paint)
      }
      rafHandle = window.requestAnimationFrame(paint)
    }

    const start = async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        if (cancelled) return
        const reader = new BrowserMultiFormatReader()
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        }
        const video = videoRef.current
        if (!video) {
          throw new Error('video element not mounted')
        }
        setStatus('Point the camera at a barcode…')
        runRafLoop()
        const controls = await reader.decodeFromConstraints(constraints, video, (result, _err) => {
          if (cancelled || lockedRef.current) return
          const video = videoRef.current
          const overlay = overlayRef.current
          if (!video || !overlay) return
          if (!result) {
            // Routine miss. Fade the overlay box out gradually by
            // clearing the detection ref every ~150 ms so we don't
            // leave a stale yellow rectangle behind.
            // (Simple impl: drop the ref immediately. The rAF loop
            // clears the canvas every frame anyway.)
            detectionRef.current = null
            return
          }
          const value = result.getText().trim()
          if (value.length === 0) return
          const overlayWidth = overlay.clientWidth
          const overlayHeight = overlay.clientHeight
          // The video is rendered with `object-fit: cover`, so source
          // pixels and overlay pixels share a scale factor centred
          // around the visible region. Compute it here so the box
          // lines up with what the user sees, not with the off-screen
          // letterboxed area.
          const points = mapResultPointsToOverlay(
            result.getResultPoints(),
            video.videoWidth,
            video.videoHeight,
            overlayWidth,
            overlayHeight,
          )
          detectionRef.current = { points, value }
          lockedRef.current = true
          setStatus(`✓ ${value}`)
          playConfirmBeep()
          // Leave the green box on-screen briefly so the operator
          // sees what we grabbed before the modal closes.
          window.setTimeout(() => {
            if (!cancelled) onDetected(value)
          }, 350)
        })
        controlsStop = () => controls.stop()
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        // eslint-disable-next-line no-console
        console.warn('[live-barcode-scanner] camera/decoder failed', error)
        setErrorMessage(humanizeCameraError(message))
        setStatus('')
      }
    }

    lockedRef.current = false
    detectionRef.current = null
    setStatus('Requesting camera…')
    setErrorMessage(null)
    void start()
    return () => {
      cancelled = true
      tearDown()
    }
  }, [open, onDetected])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live barcode scanner"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        flexDirection: 'column',
        color: '#fff',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          gap: '0.5rem',
        }}
      >
        <strong style={{ fontSize: '1rem' }}>Scan barcode</strong>
        <button
          type="button"
          className="ghost-button"
          onClick={onCancel}
          style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
        >
          ✕ Close
        </button>
      </div>
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'hidden',
          background: '#000',
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
        <canvas
          ref={overlayRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        style={{
          padding: '0.75rem 1rem',
          textAlign: 'center',
          background: 'rgba(0,0,0,0.6)',
          minHeight: '2.5rem',
        }}
      >
        {errorMessage ? (
          <span style={{ color: '#ff7a7a' }}>{errorMessage}</span>
        ) : (
          <span>{status}</span>
        )}
      </div>
    </div>
  )
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
  if (srcWidth === 0 || srcHeight === 0 || dstWidth === 0 || dstHeight === 0) {
    return []
  }
  // object-fit: cover scales the source uniformly to fully cover the
  // dst, then centre-crops the overflow.
  const scale = Math.max(dstWidth / srcWidth, dstHeight / srcHeight)
  const scaledW = srcWidth * scale
  const scaledH = srcHeight * scale
  const offsetX = (dstWidth - scaledW) / 2
  const offsetY = (dstHeight - scaledH) / 2
  return points.map((p) => ({
    x: p.getX() * scale + offsetX,
    y: p.getY() * scale + offsetY,
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
