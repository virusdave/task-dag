// Admin-only banner that fires when the helios server (this build's code)
// expects schema the live DB doesn't have. AppShell passes the already-loaded
// session so non-admin users never mount the polling implementation.
//
// Data source: GET /api/session, which always carries a
// `pendingMigrations` array (empty when the DB is up to date). The
// server-side check is cached for ~30s so polling here is cheap.
//
// This is a DRIFT WARNING ONLY — it no longer emits a psql copy-paste
// (canon rules/DB_PERFORMANCE.md: a worker/agent applies approved
// migrations to prod, not an operator). The actual apply lives behind
// the admin-gated /config/pending-migrations "Apply Now" page, which
// the banner deep-links to (automation#62).
//
// UX (see helios/AGENTS.md + Oracle review): the warning is important
// but must not permanently eat screen space, especially on mobile.
//   - Expanded state is rendered IN FLOW (position: sticky) so it pushes
//     page content down instead of overlaying/hiding it. It is compact
//     by default — the per-migration id/label list lives in a collapsed
//     <details>; the apply action is the deep-link to the admin page.
//   - "Hide for this tab" dismisses the *current* migration set for the
//     browser tab (sessionStorage), collapsing it to a small pill anchored
//     bottom-right (clear of the mobile bottom-left scroll-top chip).
//   - Tapping the pill re-expands transiently to peek at the drift set.
//   - If a NEW/different migration set appears later, the dismissal no
//     longer matches and the banner re-expands, so a fresh schema drift is
//     never silently hidden.

import { useEffect, useState } from 'react'

import {
  SessionEnvelopeSchema,
  type PendingMigration,
  type SessionEnvelope,
} from '../../shared/contracts/index.js'
import { isAdminUser } from '../../shared/domain/permissions.js'
import { buildAppPath } from '../app/paths.js'
import {
  buildPendingMigrationsSignature,
  clearDismissedSignature,
  getPendingMigrationsBannerMode,
  readDismissedSignature,
  writeDismissedSignature,
  type SignatureStorage,
} from './pendingMigrationsBannerState.js'

const POLL_INTERVAL_MS = 300_000 // DB-cost epic E1 (was 60s); pending migrations are rare

// sessionStorage can be unavailable (privacy mode, sandboxed iframe) and
// even *accessing* the property can throw; resolve it defensively once.
function getSessionStorage(): SignatureStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

const BANNER_STYLE: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  // Above the fixed top-left <BuildStamp /> (z 9999) so the tiny stamp
  // never obscures the warning heading.
  zIndex: 10000,
  padding: '10px 16px 12px',
  background: '#b00020',
  color: '#fff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 13,
  lineHeight: 1.35,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
}

const HEADER_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const HEADING_STYLE: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  letterSpacing: 0.2,
  flex: '1 1 auto',
  minWidth: 0,
}

const HIDE_BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  background: 'rgba(0, 0, 0, 0.28)',
  color: '#fff',
  border: '1px solid rgba(255, 255, 255, 0.45)',
  borderRadius: 999,
  padding: '4px 12px',
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: 'pointer',
  minHeight: 32,
  whiteSpace: 'nowrap',
}

const DETAILS_STYLE: React.CSSProperties = {
  marginTop: 6,
}

const SUMMARY_STYLE: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.95,
  userSelect: 'none',
}

const LIST_STYLE: React.CSSProperties = {
  margin: '6px 0 0 18px',
  padding: 0,
  maxHeight: '40vh',
  overflowY: 'auto',
}

const ADMIN_LINK_STYLE: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 8,
  padding: '6px 12px',
  background: 'rgba(0, 0, 0, 0.28)',
  color: '#fff',
  border: '1px solid rgba(255, 255, 255, 0.55)',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.2,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}

const PILL_STYLE: React.CSSProperties = {
  position: 'fixed',
  right: '0.75rem',
  bottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
  zIndex: 1000,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  maxWidth: 'calc(100vw - 1.5rem)',
  minHeight: 44,
  padding: '0.55rem 0.9rem',
  background: '#b00020',
  color: '#fff',
  border: '1px solid rgba(255, 255, 255, 0.35)',
  borderRadius: 999,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 13,
  fontWeight: 600,
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
  cursor: 'pointer',
}

export function PendingMigrationsBanner({
  session,
}: {
  session: SessionEnvelope
}): JSX.Element | null {
  if (!isAdminUser(session.user)) {
    return null
  }
  return <AdminPendingMigrationsBanner initialPending={session.pendingMigrations} />
}

function AdminPendingMigrationsBanner({
  initialPending,
}: {
  initialPending: PendingMigration[]
}): JSX.Element | null {
  const [pending, setPending] = useState<PendingMigration[]>(initialPending)
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() =>
    readDismissedSignature(getSessionStorage()),
  )
  // Transient: set when the user taps the pill to peek; never persisted.
  const [manuallyExpandedSignature, setManuallyExpandedSignature] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const storage = getSessionStorage()

    async function load(): Promise<void> {
      try {
        const response = await fetch(buildAppPath('/api/session'), {
          credentials: 'same-origin',
        })
        if (!response.ok) {
          return
        }
        const json = (await response.json()) as unknown
        const parsed = SessionEnvelopeSchema.safeParse(json)
        if (!parsed.success || cancelled) {
          return
        }
        const next = parsed.data.pendingMigrations
        setPending(next)
        // The drift cleared: forget any stored dismissal so a later
        // reappearance shows expanded again, and drop any peek state.
        if (next.length === 0) {
          clearDismissedSignature(storage)
          setDismissedSignature(null)
          setManuallyExpandedSignature(null)
        }
      } catch {
        // Network/parse failures shouldn't take down the page —
        // leave the banner hidden and try again next interval.
      }
    }

    void load()
    const handle = window.setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [])

  const signature = buildPendingMigrationsSignature(pending)
  const mode = getPendingMigrationsBannerMode({
    signature,
    dismissedSignature,
    manuallyExpandedSignature,
  })

  if (mode === 'hidden' || signature === null) {
    return null
  }

  const count = pending.length
  const countLabel = count === 1 ? '1 migration' : `${count} migrations`

  if (mode === 'collapsed') {
    return (
      <button
        type="button"
        style={PILL_STYLE}
        data-testid="pending-migrations-pill"
        aria-label={`Show details for ${countLabel} pending; some pages may fail until applied`}
        onClick={() => setManuallyExpandedSignature(signature)}
      >
        ⚠️ {count} pending
      </button>
    )
  }

  function handleHide(): void {
    if (signature === null) {
      return
    }
    writeDismissedSignature(getSessionStorage(), signature)
    setDismissedSignature(signature)
    setManuallyExpandedSignature(null)
  }

  return (
    <div role="alert" style={BANNER_STYLE} data-testid="pending-migrations-banner">
      <div style={HEADER_ROW_STYLE}>
        <div style={HEADING_STYLE}>
          ⚠️ Database is behind this Helios build — {countLabel} pending. Some pages may fail until
          applied.
        </div>
        <button
          type="button"
          style={HIDE_BUTTON_STYLE}
          onClick={handleHide}
          aria-label="Hide pending database migrations warning for this browser tab"
        >
          Hide for this tab
        </button>
      </div>
      <a
        href={buildAppPath('/config/pending-migrations')}
        style={ADMIN_LINK_STYLE}
        data-testid="pending-migrations-admin-link"
      >
        Review &amp; apply pending migrations →
      </a>
      <details style={DETAILS_STYLE}>
        <summary style={SUMMARY_STYLE}>Show pending migrations</summary>
        <ul style={LIST_STYLE}>
          {pending.map((migration) => (
            <li key={migration.migrationId} style={{ marginBottom: 6 }}>
              <strong>{migration.migrationId}</strong> — {migration.label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
