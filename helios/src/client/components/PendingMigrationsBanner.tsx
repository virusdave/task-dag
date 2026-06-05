// All-pages banner that fires when the helios server (this build's
// code) expects schema the live DB doesn't have. Mounted at the
// router root so it shows on every page — including /login — without
// having to plumb session data through every route loader.
//
// Data source: GET /api/session, which always carries a
// `pendingMigrations` array (empty when the DB is up to date). The
// server-side check is cached for ~30s so polling here is cheap.

import { useEffect, useState } from 'react'

import { SessionEnvelopeSchema, type PendingMigration } from '../../shared/contracts/index.js'
import { buildAppPath } from '../app/paths.js'

const POLL_INTERVAL_MS = 300_000 // DB-cost epic E1 (was 60s); pending migrations are rare

const BANNER_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 99999,
  padding: '10px 16px 12px',
  background: '#b00020',
  color: '#fff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 13,
  lineHeight: 1.35,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 4,
  letterSpacing: 0.2,
}

const LIST_STYLE: React.CSSProperties = {
  margin: '4px 0 0 18px',
  padding: 0,
}

const CMD_STYLE: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 6px',
  background: 'rgba(0, 0, 0, 0.35)',
  borderRadius: 3,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  userSelect: 'all',
}

export function PendingMigrationsBanner(): JSX.Element | null {
  const [pending, setPending] = useState<PendingMigration[]>([])

  useEffect(() => {
    let cancelled = false

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
        setPending(parsed.data.pendingMigrations)
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

  if (pending.length === 0) {
    return null
  }

  return (
    <div role="alert" style={BANNER_STYLE} data-testid="pending-migrations-banner">
      <div style={HEADING_STYLE}>
        ⚠️ Database is behind this Helios build —{' '}
        {pending.length === 1
          ? '1 migration must be applied manually'
          : `${pending.length} migrations must be applied manually`}
      </div>
      <ul style={LIST_STYLE}>
        {pending.map((migration) => (
          <li key={migration.migrationId} style={{ marginBottom: 4 }}>
            <strong>{migration.migrationId}</strong> — {migration.label}
            <code style={CMD_STYLE}>{migration.applyCommand}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
