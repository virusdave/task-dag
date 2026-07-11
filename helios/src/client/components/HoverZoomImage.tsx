import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

/**
 * Shared `<img>` wrapper that, after a brief hover, pops up a larger
 * version of the image so reviewers can see detail without leaving
 * the page or clicking through.
 *
 * The popup is rendered as a viewport-fixed overlay anchored next to
 * the thumbnail with edge-detection so it stays on screen near either
 * side of the viewport. Pointer-events are disabled on the popup
 * itself so the user can move the mouse through it without
 * dismissing-then-reshowing the zoom.
 *
 * If `openHref` is provided, the thumbnail is rendered inside an
 * anchor that opens that URL in a new tab (e.g. the competitor's
 * source listing on the dispensary's website, or the raw image URL
 * itself). Middle-click / Ctrl-click works as expected because it's a
 * real `<a>`. Without `openHref` it's a plain `<img>` and the caller
 * can wrap / position it however it wants — for example
 * `PendingPurchasesPage`'s "pick as primary image" `<button>`.
 *
 * Used on:
 *   - `/catalog/pending-purchases` listing thumbnails + picture-options
 *     panel,
 *   - `/pricing/review` supporting market listings,
 *   - `/catalog/groups/:id` matched competitor listings.
 *
 * Originally lived inline inside `PendingPurchasesPage.tsx`; extracted
 * here per the canonical-product-row consolidation effort.
 */
export function HoverZoomImage({
  alt,
  src,
  style,
  zoomedSize = 360,
  delayMs = 350,
  openHref,
  openTitle,
  expandOnClick = false,
}: {
  alt: string
  src: string
  style?: CSSProperties
  /** Pixel side-length of the popped-up preview. */
  zoomedSize?: number
  /** Delay before the zoom popup appears. */
  delayMs?: number
  /**
   * Optional URL. When provided, the thumbnail is wrapped in an
   * `<a target="_blank">` so clicking / middle-clicking opens that URL
   * (typically the competitor source listing) in a new tab.
   */
  openHref?: string | null
  /** Tooltip text for the link wrapper, if `openHref` is set. */
  openTitle?: string
  /** Render an accessible thumbnail button that toggles the large preview. */
  expandOnClick?: boolean
}): JSX.Element {
  const ref = useRef<HTMLImageElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [popup, setPopup] = useState<{ left: number; size: number; top: number } | null>(null)

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const computePosition = (): { left: number; size: number; top: number } => {
    const el = ref.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    const size = Math.max(0, Math.min(zoomedSize, vw - margin * 2, vh - margin * 2))
    if (!el) {
      return { left: margin, size, top: margin }
    }
    const rect = el.getBoundingClientRect()
    // Prefer placing the popup to the right of the thumbnail; fall
    // back to the left if there isn't room.
    let left = rect.right + margin
    if (left + size + margin > vw) {
      left = rect.left - margin - size
    }
    if (left < margin) {
      left = Math.max(margin, Math.min(vw - size - margin, rect.left))
    }
    let top = rect.top
    if (top + size + margin > vh) {
      top = vh - size - margin
    }
    if (top < margin) {
      top = margin
    }
    return { left, size, top }
  }

  const handleEnter = () => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setPopup(computePosition())
      timerRef.current = null
    }, delayMs)
  }

  const handleLeave = () => {
    clearTimer()
    setPopup(null)
  }

  // If the caller stops propagation on the wrapping link/button (e.g.
  // PendingPurchasesPage's "pick as primary" button does its own
  // click handling), we still want the hover popup to dismiss when
  // they click — otherwise it can hover-stick on touch / fast-click.
  const handleClick = (_event: MouseEvent) => {
    clearTimer()
    setPopup((current) => expandOnClick && current === null ? computePosition() : null)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') setPopup(null)
  }

  const thumbnail = (
    <img
      alt={alt}
      loading="lazy"
      onClick={expandOnClick ? undefined : handleClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      ref={ref}
      src={src}
      style={style}
    />
  )
  const popupImage = popup ? (
    <img
      alt={alt}
      src={src}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  ) : null
  const popupStyle: CSSProperties | undefined = popup ? {
    position: 'fixed', left: popup.left, top: popup.top, width: popup.size, height: popup.size,
    background: '#fff', border: '1px solid #ccc', borderRadius: '4px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '4px', zIndex: 1000,
  } : undefined

  return (
    <>
      {expandOnClick ? (
        <button
          aria-expanded={popup !== null}
          aria-label={`${alt}; ${popup === null ? 'expand' : 'close'} image`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          style={{ background: 'none', border: 0, cursor: 'zoom-in', lineHeight: 0, padding: 0 }}
          type="button"
        >
          {thumbnail}
        </button>
      ) : openHref ? (
        <a
          href={openHref}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          rel="noopener noreferrer"
          target="_blank"
          title={openTitle ?? 'Open in a new tab'}
          style={{ display: 'inline-block', lineHeight: 0 }}
        >
          {thumbnail}
        </a>
      ) : (
        thumbnail
      )}
      {popup && expandOnClick ? (
        <button
          aria-label={`Close expanded ${alt} image`}
          onClick={(event) => {
            event.stopPropagation()
            setPopup(null)
          }}
          style={popupStyle}
          type="button"
        >
          {popupImage}
        </button>
      ) : popup ? (
        <div style={{ ...popupStyle, pointerEvents: 'none' }}>{popupImage}</div>
      ) : null}
    </>
  )
}
