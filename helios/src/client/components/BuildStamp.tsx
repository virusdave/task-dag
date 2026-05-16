// Tiny build-stamp overlay anchored to the top-left of every page,
// including /login. Renders the short git SHA the bundle was built
// from and the build timestamp. The values are baked into the bundle
// at vite-build time (see vite.config.ts `define`), so the only way
// these change is a fresh build + deploy — making it trivial to spot
// when production is serving stale code.

declare const __HELIOS_BUILD_SHA__: string
declare const __HELIOS_BUILD_SUBJECT__: string
declare const __HELIOS_BUILD_TIME__: string

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

export function BuildStamp(): JSX.Element {
  const sha = __HELIOS_BUILD_SHA__
  const builtAt = __HELIOS_BUILD_TIME__
  // Render in America/New_York at hh:mm resolution so it matches the
  // ops team's wall clock. The tzdb abbreviation (EST/EDT) is shown
  // so the stamp is unambiguous across DST transitions.
  const compactTime = formatCompactNewYork(builtAt)
  const title = `Helios bundle\nsha: ${sha}\nbuilt: ${builtAt}\nsubject: ${__HELIOS_BUILD_SUBJECT__ || '(unavailable)'}`
  return (
    <div style={STYLE} title={title} aria-label="helios build stamp">
      {sha} · {compactTime}
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
