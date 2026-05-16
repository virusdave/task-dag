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
  // Render the timestamp as "YYYY-MM-DD HH:MM UTC" so it stays compact
  // but is unambiguous about timezone.
  const compactTime = formatCompactUtc(builtAt)
  const title = `Helios bundle\nsha: ${sha}\nbuilt: ${builtAt}\nsubject: ${__HELIOS_BUILD_SUBJECT__ || '(unavailable)'}`
  return (
    <div style={STYLE} title={title} aria-label="helios build stamp">
      {sha} · {compactTime}
    </div>
  )
}

function formatCompactUtc(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}Z`
}
