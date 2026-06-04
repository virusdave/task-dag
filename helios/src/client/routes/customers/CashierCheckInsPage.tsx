// Cashier-tablet "live check-ins" display.
//
// virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase D1.
//
// Mounted at /admin/customers/check-ins/cashier. Designed for the
// landscape-mode tablet at the checkout counter facing cashiers.
// The page is intentionally a stripped-down, privacy-redacted
// variant of /admin/customers/check-ins:
//
//   - All PII is redacted server-side. The wire payload carries a
//     pre-redacted `displayName` ("First L.") and NO state / postal /
//     city / address / coords / document fields. A cashier-account
//     session simply cannot pull richer data through this endpoint.
//
//   - The "Expanded" toggle the operator page exposes is forced off
//     here. There is nothing to expand.
//
//   - Live updates: same cheap MAX(visitor_scans.id) highwater
//     polling pattern as the customer-origin map page
//     (CustomerMapPage.tsx) — one indexed pkey MAX per probe,
//     ~sub-millisecond on the server, so leaving the tablet open
//     all day costs essentially nothing.
//
//   - When a NEW scan id appears in the response that wasn't in
//     the previous one, the page:
//       (a) plays a chime — distinct tones for "first visit" vs
//           "returning"; synthesised via the Web Audio API so we
//           don't have to ship audio assets;
//       (b) fires a browser Notification with the redacted name
//           and visit type, so a cashier glancing away doesn't
//           miss anyone.
//
//   - First Visit vs Returning is color-coded on the row itself
//     (success-toned for returning, warning-toned for new). Last
//     Visit Date is shown when known.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CashierVisitorScansResponseSchema,
  VisitorScansHighwaterResponseSchema,
  type CashierVisitorScanItem,
  type CashierVisitorScansResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

// Polling cadence for the highwater probe. 3s is the operator-
// targeted "feel live" budget — below human-attention threshold,
// and the probe itself is one indexed MAX so even at 20 tablet
// instances we'd see at most a few hundred trivial queries per
// minute against `visitor_scans`. Pauses entirely when the tab is
// hidden.
const HIGHWATER_POLL_MS = 3_000

// Top-N rolling feed size. The cashier really only needs the most
// recent handful of scans; 25 leaves comfortable headroom for a
// busy shift's worth of in-view rows while keeping per-poll
// payload + per-row lateral cost small.
const FEED_LIMIT = 25

// Pause-after-arrival window for chime / notification — guards
// against spamming the cashier during a backfill burst that
// happens to coincide with the page mount (since on the very
// first load every row is "new" to us). We only alert on scans
// whose id is strictly greater than the highest id we saw on the
// previous successful fetch.

interface DisplayState {
  data: CashierVisitorScansResponse | null
  error: string | null
  loadedAt: number | null
}

type ChimeTone = 'new' | 'returning'

// -----------------------------------------------------------------
// Web Audio synthesis. No audio assets shipped — both chimes are
// generated on the fly via oscillator nodes. Safari requires the
// AudioContext to be created (and resumed) from a user gesture,
// so we lazily construct it on the first "Start" button press
// and reuse it for every later chime.
// -----------------------------------------------------------------

class ChimePlayer {
  private ctx: AudioContext | null = null
  private enabled = false

  enable(): void {
    if (this.ctx === null) {
      const Ctor =
        typeof window !== 'undefined'
          ? // Cast through unknown to satisfy `webkitAudioContext` lookup
            // without leaning on a `lib.dom` type that may not be present.
            ((window as unknown as Record<string, typeof AudioContext>)
              .AudioContext ??
              (window as unknown as Record<string, typeof AudioContext>)
                .webkitAudioContext)
          : undefined
      if (!Ctor) return
      this.ctx = new Ctor()
    }
    void this.ctx.resume().catch(() => {
      /* ignore — autoplay policy not satisfied yet */
    })
    this.enabled = true
  }

  isEnabled(): boolean {
    return this.enabled && this.ctx !== null
  }

  play(tone: ChimeTone): void {
    if (!this.enabled || this.ctx === null) return
    const ctx = this.ctx
    const now = ctx.currentTime
    if (tone === 'new') {
      // Bright two-tone arpeggio for a brand-new visitor.
      this.playTone(ctx, now + 0.0, 880, 0.35, 0.18) // A5
      this.playTone(ctx, now + 0.18, 1320, 0.45, 0.18) // E6
    } else {
      // Warm single tone for a returning visitor.
      this.playTone(ctx, now + 0.0, 523.25, 0.55, 0.22) // C5
    }
  }

  private playTone(
    ctx: AudioContext,
    start: number,
    frequency: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = frequency
    // Quick attack, gentle decay so it sounds like a chime not a beep.
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + durationSec + 0.05)
  }
}

// -----------------------------------------------------------------
// Browser Notifications. We request permission on the "Start"
// button press (the only place we have a user-gesture context),
// and then surface one notification per genuinely-new scan id.
// Notifications auto-dismiss after a few seconds.
// -----------------------------------------------------------------

function notifyArrival(item: CashierVisitorScanItem): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    const title = item.isFirstVisit
      ? `New visitor: ${item.displayName}`
      : `Returning visitor: ${item.displayName}`
    const body = item.isFirstVisit
      ? `First time at ${item.siteSlug.toUpperCase()}`
      : `Visit ${item.totalScans} · last seen ${formatRelative(item.lastVisitAt)}`
    const n = new Notification(title, {
      body,
      // We deliberately do NOT set an icon — the page is on a
      // dedicated tablet, the browser's default lock-screen-friendly
      // icon is fine.
      tag: `cashier-scan-${item.id}`,
      requireInteraction: false,
    })
    // Auto-close after 6s in case the OS doesn't.
    window.setTimeout(() => n.close(), 6_000)
  } catch {
    /* swallow — notification surface is best-effort */
  }
}

// -----------------------------------------------------------------
// Time formatting.
// -----------------------------------------------------------------

function formatClock(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function formatRelative(iso: string | null): string {
  if (iso === null) return 'never'
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const min = Math.round(ms / 60_000)
    if (min < 1) return 'just now'
    if (min < 60) return `${min}m ago`
    const hours = Math.round(min / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.round(hours / 24)
    if (days < 30) return `${days}d ago`
    return formatDate(iso)
  } catch {
    return iso ?? '—'
  }
}

function formatCurrency(value: number | null): string {
  if (value === null) return '—'
  return `$${value.toFixed(2)}`
}

// -----------------------------------------------------------------
// Component.
// -----------------------------------------------------------------

export function CashierCheckInsPage(): JSX.Element {
  const [state, setState] = useState<DisplayState>({
    data: null,
    error: null,
    loadedAt: null,
  })
  const [armed, setArmed] = useState<boolean>(false)
  const [notifPermission, setNotifPermission] = useState<
    'default' | 'granted' | 'denied' | 'unsupported'
  >(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })
  const chimeRef = useRef<ChimePlayer | null>(null)
  if (chimeRef.current === null) {
    chimeRef.current = new ChimePlayer()
  }
  // Latest seen scan id; used to suppress chimes for the rows we
  // got on the very first load (we want to alert on arrivals while
  // the page is mounted, not "re-announce" the existing feed).
  const seenIdRef = useRef<number | null>(null)
  // Initial-load completion flag; used to gate chime/notification
  // suppression on the first batch.
  const initialLoadDoneRef = useRef<boolean>(false)

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const next = await loadJson(
        `/api/admin/customers/check-ins/cashier?limit=${FEED_LIMIT}`,
        CashierVisitorScansResponseSchema,
      )
      // Detect genuinely-new rows: those with id > the highest id we
      // had at the END of the previous successful fetch.
      const lastSeen = seenIdRef.current
      const arrived: CashierVisitorScanItem[] = []
      if (initialLoadDoneRef.current && lastSeen !== null) {
        for (const item of next.items) {
          if (item.id > lastSeen) arrived.push(item)
        }
      }
      seenIdRef.current = next.maxScanId ?? seenIdRef.current
      initialLoadDoneRef.current = true

      setState({ data: next, error: null, loadedAt: Date.now() })

      // Fire chime + notification per arrival, oldest-first so the
      // most-recent is the last thing the cashier hears.
      if (armed && arrived.length > 0) {
        const ordered = [...arrived].sort((a, b) => a.id - b.id)
        for (const item of ordered) {
          const tone: ChimeTone = item.isFirstVisit ? 'new' : 'returning'
          chimeRef.current?.play(tone)
          notifyArrival(item)
        }
      }
    } catch (cause) {
      setState((prev) => ({
        ...prev,
        error: cause instanceof Error ? cause.message : 'Failed to load check-ins.',
      }))
    }
  }, [armed])

  // Initial load + cleanup-on-unmount.
  useEffect(() => {
    void refetch()
  }, [refetch])

  // Highwater poll. Cheap MAX(id) every HIGHWATER_POLL_MS; only on a
  // bump do we trigger the heavier full-feed fetch via `refetch`.
  // Pauses when the tab is hidden (visibility API).
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      ) {
        return
      }
      try {
        const probe = await loadJson(
          '/api/admin/customers/check-ins/cashier/highwater',
          VisitorScansHighwaterResponseSchema,
        )
        if (cancelled) return
        const lastSeen = seenIdRef.current
        const next = probe.maxScanId
        if (next !== null && (lastSeen === null || next > lastSeen)) {
          await refetch()
        }
      } catch {
        // Swallow — next tick retries. A failed probe must not
        // escalate into an error banner on this surface.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void tick()
          }, HIGHWATER_POLL_MS)
        }
      }
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        void tick()
      }
    }

    void tick()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      cancelled = true
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [refetch])

  const handleArm = useCallback(async (): Promise<void> => {
    chimeRef.current?.enable()
    // Test chime so the cashier knows audio is alive.
    chimeRef.current?.play('returning')
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const result = await Notification.requestPermission()
        setNotifPermission(result)
      } catch {
        /* ignore */
      }
    } else if (typeof Notification !== 'undefined') {
      setNotifPermission(Notification.permission)
    }
    setArmed(true)
  }, [])

  const items = state.data?.items ?? []
  const totalShown = items.length
  const newCount = useMemo(() => items.filter((i) => i.isFirstVisit).length, [items])
  const returningCount = totalShown - newCount

  return (
    <section className="cashier-checkins-page">
      <header className="cashier-header">
        <div className="cashier-title-row">
          <h2 className="cashier-title">Check-ins (cashier display)</h2>
          <div className="cashier-meta">
            <Pill tone="muted">{`${totalShown} shown`}</Pill>
            <Pill tone="warning">{`new: ${newCount}`}</Pill>
            <Pill tone="success">{`returning: ${returningCount}`}</Pill>
            {state.loadedAt !== null ? (
              <span className="subtle-copy">updated {formatClock(new Date(state.loadedAt).toISOString())}</span>
            ) : null}
          </div>
        </div>
        <div className="cashier-controls">
          {!armed ? (
            <button
              type="button"
              className="primary-button cashier-arm-button"
              onClick={() => {
                void handleArm()
              }}
              title="Browsers require a user click before audio + notifications are allowed; tap to enable both."
            >
              Tap to enable chime + notifications
            </button>
          ) : (
            <>
              <Pill tone="success">chime on</Pill>
              <Pill tone={notifPermission === 'granted' ? 'success' : 'muted'}>
                {`notifications: ${notifPermission}`}
              </Pill>
              <button
                type="button"
                className="ghost-button"
                onClick={() => chimeRef.current?.play('new')}
              >
                Test new chime
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => chimeRef.current?.play('returning')}
              >
                Test returning chime
              </button>
            </>
          )}
        </div>
      </header>

      {state.error !== null ? (
        <div className="cashier-error">
          <Pill tone="danger">load failed</Pill>
          <span className="subtle-copy">{state.error}</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="cashier-empty subtle-copy">
          {state.data === null ? 'Loading…' : 'No recent check-ins yet.'}
        </div>
      ) : (
        <ol className="cashier-feed">
          {items.map((item) => (
            <li key={item.id}>
              <article
                className={`cashier-card ${item.isFirstVisit ? 'is-new' : 'is-returning'}`}
              >
                <div className="cashier-card-row1">
                  <div className="cashier-card-name">{item.displayName}</div>
                  <div className="cashier-card-time">
                    {formatClock(item.scannedAt ?? item.ingestedAt)}
                  </div>
                </div>
                <div className="cashier-card-row2">
                  <Pill tone={item.isFirstVisit ? 'warning' : 'success'}>
                    {item.isFirstVisit ? 'First visit' : `Returning · visit ${item.totalScans}`}
                  </Pill>
                  <Pill tone={item.siteSlug === 'bx' ? 'success' : 'warning'}>
                    {item.siteSlug.toUpperCase()}
                  </Pill>
                  {item.isFirstVisit ? null : (
                    <span className="cashier-last-visit subtle-copy">
                      Last visit {formatDate(item.lastVisitAt)} ({formatRelative(item.lastVisitAt)})
                    </span>
                  )}
                </div>
                {item.sweedSummary !== null ? (
                  <div className="cashier-card-row3">
                    <span className="cashier-sweed-cell">
                      <span className="cashier-sweed-label">Purchases</span>
                      <span className="cashier-sweed-value">{item.sweedSummary.purchaseCount}</span>
                    </span>
                    <span className="cashier-sweed-cell">
                      <span className="cashier-sweed-label">Total spent</span>
                      <span className="cashier-sweed-value">
                        {formatCurrency(item.sweedSummary.lifetimeSpendDollars)}
                      </span>
                    </span>
                    <span className="cashier-sweed-cell">
                      <span className="cashier-sweed-label">Avg</span>
                      <span className="cashier-sweed-value">
                        {formatCurrency(item.sweedSummary.averagePurchaseDollars)}
                      </span>
                    </span>
                    {item.sweedSummary.favoriteCategoryName !== null ? (
                      <span className="cashier-sweed-cell">
                        <span className="cashier-sweed-label">Favorite category</span>
                        <span className="cashier-sweed-value">
                          {item.sweedSummary.favoriteCategoryName}
                        </span>
                      </span>
                    ) : null}
                    {item.sweedSummary.favoriteProductName !== null ? (
                      <span className="cashier-sweed-cell">
                        <span className="cashier-sweed-label">Favorite product</span>
                        <span className="cashier-sweed-value">
                          {item.sweedSummary.favoriteProductName}
                        </span>
                      </span>
                    ) : null}
                    <span className="cashier-sweed-cell">
                      <span className="cashier-sweed-label">Last purchase</span>
                      <span className="cashier-sweed-value">
                        {formatRelative(item.sweedSummary.latestPurchaseAt)}
                      </span>
                    </span>
                  </div>
                ) : !item.isCrmLinked ? (
                  <div className="cashier-card-row3 subtle-copy">
                    No CRM profile yet — first purchase will create it.
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
