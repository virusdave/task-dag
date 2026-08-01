// Escalating, dismissable "review the agent-waste backlog" reminder (issue
// #57, ask #3). Rendered once by the AppShell so an admin sees it on ANY page
// (not only the review queue itself). It is admin-gated, fails SILENT when the
// backlog is unreadable (never nags on a broken transport), and hides itself
// while the admin is already on the review page.
//
// "Escalating" lives entirely in the pure helpers (agentWasteReminderShared):
// the busier / staler / more wasteful the queue, the shorter the snooze after
// a dismiss, and a backlog that GROWS after a dismiss (new observations
// arrive) re-surfaces immediately. This component only wires those decisions
// to the fetch lifecycle, localStorage, and a single dismissable banner -- it
// is deliberately NOT a modal.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useRouteLoaderData } from 'react-router-dom'

import type {
  AgentWasteBacklogResponse,
  SessionEnvelope,
} from '../../shared/contracts/index.js'
import { isAdminUser } from '../../shared/domain/permissions.js'
import { fetchAgentWasteBacklog } from '../routes/config/agentWasteReviewShared.js'
import {
  computeBacklogPressure,
  nextDismissState,
  parseDismissState,
  shouldShowReminder,
  type BacklogPressure,
  type ReminderDismissState,
} from '../routes/config/agentWasteReminderShared.js'

// App-relative path of the review queue (router.tsx: `config/agent-waste`).
// Compared against react-router's `location.pathname`, which already has the
// deployment base path stripped, so this is NOT run through buildAppPath.
const REVIEW_QUEUE_PATH = '/config/agent-waste'
// localStorage key for the per-browser dismiss/snooze state. Versioned so a
// future change to the persisted shape can't be mis-read as valid.
const DISMISS_STORAGE_KEY = 'helios.agentWaste.reminder.dismiss.v2'
// Re-poll the backlog on the same cadence as the review page (60s) so the
// reminder's tier tracks the queue without a manual reload.
const REFRESH_INTERVAL_MS = 60_000

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Short "why now" clause from the strongest non-count signal, or null. */
function pressureReason(pressure: BacklogPressure): string | null {
  if (pressure.totalWastedTokens >= 50_000) {
    return `≈${Math.round(pressure.totalWastedTokens / 1000)}k wasted tokens so far`
  }
  if (pressure.oldestAgeMs >= MS_PER_DAY) {
    const days = Math.floor(pressure.oldestAgeMs / MS_PER_DAY)
    return `oldest has waited ${days} day${days === 1 ? '' : 's'}`
  }
  if (pressure.oldestAgeMs >= MS_PER_HOUR) {
    const hours = Math.floor(pressure.oldestAgeMs / MS_PER_HOUR)
    return `oldest has waited ${hours} hour${hours === 1 ? '' : 's'}`
  }
  return null
}

/** Banner tone + headline for a (non-none) tier. Presentational only. */
function reminderPresentation(
  pressure: BacklogPressure,
): { tone: 'notice' | 'warn' | 'danger'; headline: string } {
  const count = pressure.count
  const items = `${count} observation${count === 1 ? '' : 's'}`
  const reason = pressureReason(pressure)
  const why = reason ? ` — ${reason}` : ''
  switch (pressure.tier) {
    case 'critical':
      return {
        tone: 'danger',
        headline: `The agent-waste review queue is badly backlogged: ${items} awaiting review${why}.`,
      }
    case 'high':
      return {
        tone: 'danger',
        headline: `The agent-waste review queue needs attention: ${items} awaiting review${why}.`,
      }
    case 'medium':
      return {
        tone: 'warn',
        headline: `${items} are waiting in the agent-waste review queue${why}.`,
      }
    case 'low':
    case 'none':
    default:
      return {
        tone: 'notice',
        headline: `${items} awaiting review in the agent-waste queue${why}.`,
      }
  }
}

function readDismissState(): ReminderDismissState | null {
  if (typeof window === 'undefined') {
    return null
  }
  return parseDismissState(window.localStorage.getItem(DISMISS_STORAGE_KEY))
}

export function AgentWasteReviewReminder() {
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const location = useLocation()
  const isAdmin = isAdminUser(session?.user)

  const [data, setData] = useState<AgentWasteBacklogResponse | null>(null)
  // Persisted dismiss/snooze state, mirrored into React state so a dismiss
  // (or a cross-tab `storage` event) re-renders. Initialized from localStorage.
  const [dismissState, setDismissState] = useState<ReminderDismissState | null>(() =>
    readDismissState(),
  )
  // Re-evaluate the snooze clock periodically so a reminder that is only
  // hidden by an elapsed-time snooze re-appears without a reload.
  const [nowTick, setNowTick] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    // Only admins can read the backlog (server route is admin-gated); don't
    // even issue the request for a non-admin.
    if (!isAdmin) {
      return
    }
    try {
      const response = await fetchAgentWasteBacklog()
      setData(response)
    } catch {
      // Fail SILENT: an unavailable/broken backlog transport must not nag.
      setData(null)
    }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin) {
      return
    }
    let cancelled = false
    const run = async () => {
      if (cancelled) {
        return
      }
      await refresh()
    }
    void run()
    const poll = window.setInterval(() => {
      setNowTick(Date.now())
      void run()
    }, REFRESH_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Re-engagement: re-read the queue and the clock so newly-arrived
        // work can re-surface the reminder immediately.
        setNowTick(Date.now())
        void run()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isAdmin, refresh])

  // Keep the dismiss state in sync when another tab dismisses/clears it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === DISMISS_STORAGE_KEY) {
        setDismissState(readDismissState())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const pressure = useMemo(() => {
    if (!data || !data.source.available) {
      return null
    }
    return computeBacklogPressure(data.observations, nowTick)
  }, [data, nowTick])

  const onReviewPage = location.pathname === REVIEW_QUEUE_PATH
  const visible =
    isAdmin &&
    pressure !== null &&
    !onReviewPage &&
    shouldShowReminder(pressure, nowTick, dismissState)

  const dismiss = useCallback(() => {
    if (!pressure) {
      return
    }
    const next = nextDismissState(pressure, Date.now())
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(next))
    }
    setDismissState(next)
  }, [pressure])

  if (!visible || !pressure || pressure.tier === 'none') {
    return null
  }

  const { tone, headline } = reminderPresentation(pressure)

  return (
    <section
      className={`agent-waste-reminder agent-waste-reminder--${tone}`}
      role="status"
      aria-label="Agent-waste review reminder"
    >
      <div className="agent-waste-reminder__body">
        <strong className="agent-waste-reminder__headline">{headline}</strong>
        <span className="subtle-copy">
          Promoting patterns to the advisory catalog is how future agents stop repeating them.
        </span>
      </div>
      <div className="agent-waste-reminder__actions">
        <Link to={REVIEW_QUEUE_PATH} className="agent-waste-reminder__cta">
          Review now <span aria-hidden="true">→</span>
        </Link>
        <button
          type="button"
          className="ghost-button"
          onClick={dismiss}
          aria-label="Dismiss the agent-waste review reminder"
        >
          Dismiss
        </button>
      </div>
    </section>
  )
}
