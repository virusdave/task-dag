// Tiny build-stamp overlay anchored to the top-left of every page,
// including /login. Renders the short git SHA the bundle was built
// from and the build timestamp.
//
// The values come from /build-info.json, which the vite build emits
// alongside the hashed asset bundle. We deliberately do NOT bake them
// into the JS bundle (via vite `define`) because doing so changes the
// bundle hash on every build (timestamp drifts), which rotates the
// /assets/* filenames on every redeploy and bricks open browser tabs
// whose cached index.html still references the previous hash.

import { useEffect, useState } from 'react'

interface BuildInfo {
  sha: string
  subject: string
  builtAt: string
}

const STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 2,
  left: 4,
  zIndex: 9999,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  lineHeight: 1.2,
  color: 'rgba(255, 255, 255, 0.55)',
  background: 'rgba(0, 0, 0, 0.25)',
  padding: '1px 5px',
  borderRadius: 3,
  pointerEvents: 'auto',
  userSelect: 'all',
}

export function BuildStamp(): JSX.Element | null {
  const [info, setInfo] = useState<BuildInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/build-info.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled || !payload || typeof payload !== 'object') {
          return
        }
        const candidate = payload as Partial<BuildInfo>
        if (
          typeof candidate.sha === 'string' &&
          typeof candidate.subject === 'string' &&
          typeof candidate.builtAt === 'string'
        ) {
          setInfo({ sha: candidate.sha, subject: candidate.subject, builtAt: candidate.builtAt })
        }
      })
      .catch(() => {
        // Stamp is purely cosmetic; ignore fetch errors.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!info) {
    return null
  }

  const compactTime = formatCompactNewYork(info.builtAt)
  const title = `Helios bundle\nsha: ${info.sha}\nbuilt: ${info.builtAt}\nsubject: ${info.subject || '(unavailable)'}`
  return (
    <div style={STYLE} title={title} aria-label="helios build stamp">
      {info.sha} · {compactTime}
    </div>
  )
}

const NEW_YORK_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
})

function formatCompactNewYork(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  // en-CA gives "YYYY-MM-DD, HH:MM EDT" with a literal comma.
  // Normalize to "YYYY-MM-DD HH:MM EDT".
  const parts = NEW_YORK_FORMATTER.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const yyyy = get('year')
  const mm = get('month')
  const dd = get('day')
  const hh = get('hour') === '24' ? '00' : get('hour') // some platforms emit 24
  const mi = get('minute')
  const tz = get('timeZoneName')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} ${tz}`
}
