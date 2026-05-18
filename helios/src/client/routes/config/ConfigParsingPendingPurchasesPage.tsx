// Config -> Parsing -> Purchases
//
// Shows the live state of the parsekit-based pending-purchase parser
// running in reverse-shadow mode against the legacy hardcoded
// waterfall:
//
//   - which parsekit snapshot the helios-server has loaded
//     (sha, when, how many parsers, dispatch table)
//   - regression counters over the last hour / 24h / all-time
//     (a "regression" is any case where parsekit and legacy
//     disagreed enough to record an event; pure-agreement parses
//     are *not* persisted, so the table is bounded)
//   - the most recent events (newest first) with input, parser id,
//     diff fields, and the parsekit / legacy outputs side-by-side
//
// LitAlerts and CompetitorEcom siblings will land next to this page.

import { useEffect } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  ConfigParsingPendingPurchasesResponseSchema,
  type ConfigParsingPendingPurchasesResponse,
  type ParsekitReverseShadowEvent,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

const AUTO_REFRESH_INTERVAL_MS = 30_000

export async function configParsingPendingPurchasesLoader(): Promise<
  ConfigParsingPendingPurchasesResponse
> {
  return loadJson(
    '/api/config/parsing/pending-purchases',
    ConfigParsingPendingPurchasesResponseSchema,
  )
}

function kindLabel(kind: ParsekitReverseShadowEvent['kind']): string {
  switch (kind) {
    case 'regression_unmatched':
      return 'Regression — parsekit unmatched'
    case 'regression_diff':
      return 'Regression — output differs'
    case 'legacy_threw':
      return 'Legacy threw (parsekit accepted)'
    default:
      return kind
  }
}

function kindTone(kind: ParsekitReverseShadowEvent['kind']): PillProps['tone'] {
  switch (kind) {
    case 'regression_unmatched':
      return 'danger'
    case 'regression_diff':
      return 'warning'
    case 'legacy_threw':
      return 'success'
    default:
      return 'muted'
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function formatLoadedAt(ms: number | null): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString()
}

function formatRelative(ms: number | null): string {
  if (ms == null) return ''
  const delta = Date.now() - ms
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

function renderJson(value: unknown): string {
  if (value == null) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ConfigParsingPendingPurchasesPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as ConfigParsingPendingPurchasesResponse
  const revalidator = useRevalidator()

  // Periodic refresh so the page is useful as a "what's happening right
  // now" dashboard, not a one-shot.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (revalidator.state === 'idle') {
        revalidator.revalidate()
      }
    }, AUTO_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [revalidator])

  const { registry, countsLast1h, countsLast24h, countsAllTime, recent } = data

  return (
    <div style={{ padding: '1rem', maxWidth: 1200 }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Parsing → Purchases (reverse shadow)</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Parsekit is the live parser for pending-purchase product names; the legacy hardcoded
        waterfall runs as a comparator and as the safety net for tenants without a parsekit
        config yet. The table below records every case where the two disagreed.
      </p>

      <section style={{ marginTop: '1rem' }}>
        <h2 style={{ marginBottom: '0.25rem' }}>Snapshot</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem' }}>
          <span>SHA</span>
          <code>{registry.sha ?? '— (no snapshot loaded yet)'}</code>
          <span>Parsers loaded</span>
          <code>{registry.parsersLoaded}</code>
          <span>Loaded at</span>
          <code>
            {formatLoadedAt(registry.loadedAtMs)}
            {registry.loadedAtMs != null ? ` (${formatRelative(registry.loadedAtMs)})` : ''}
          </code>
          <span>Last refresh attempt</span>
          <code>
            {formatLoadedAt(registry.lastAttemptAtMs)}
            {registry.lastAttemptAtMs != null
              ? ` (${formatRelative(registry.lastAttemptAtMs)})`
              : ''}
          </code>
          <span>Successful loads</span>
          <code>{registry.successfulLoads}</code>
          <span>Failed loads</span>
          <code>{registry.failedLoads}</code>
        </div>
        {registry.lastErrors.length > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <strong>Last errors:</strong>
            <ul>
              {registry.lastErrors.map((e, i) => (
                <li key={i}>
                  <code>{e}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ marginBottom: '0.25rem' }}>Parsekit dispatch table</h2>
        <p style={{ color: '#666', marginTop: 0 }}>
          The reverse-shadow harness routes an input to the first parser whose detect-prefix
          matches case-insensitively. Inputs that match no prefix fall through to legacy
          silently (this is the expected path for tenants not yet ported, currently:{' '}
          <code>hr-botanical</code>).
        </p>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cellHeader}>parserId</th>
              <th style={cellHeader}>tenantId</th>
              <th style={cellHeader}>detect.prefixes</th>
            </tr>
          </thead>
          <tbody>
            {registry.parsers.map((p) => (
              <tr key={p.parserId}>
                <td style={cell}>
                  <code>{p.parserId}</code>
                </td>
                <td style={cell}>
                  <code>{p.tenantId}</code>
                </td>
                <td style={cell}>
                  {p.prefixes.map((prefix, i) => (
                    <code key={i} style={{ marginRight: '0.5rem' }}>
                      {JSON.stringify(prefix)}
                    </code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ marginBottom: '0.25rem' }}>Regression counters</h2>
        <table style={{ borderCollapse: 'collapse', width: 'auto' }}>
          <thead>
            <tr>
              <th style={cellHeader}>Window</th>
              <th style={cellHeader}>regression_unmatched</th>
              <th style={cellHeader}>regression_diff</th>
              <th style={cellHeader}>legacy_threw</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={cell}>Last 1h</td>
              <td style={cell}>{countsLast1h.regression_unmatched}</td>
              <td style={cell}>{countsLast1h.regression_diff}</td>
              <td style={cell}>{countsLast1h.legacy_threw}</td>
            </tr>
            <tr>
              <td style={cell}>Last 24h</td>
              <td style={cell}>{countsLast24h.regression_unmatched}</td>
              <td style={cell}>{countsLast24h.regression_diff}</td>
              <td style={cell}>{countsLast24h.legacy_threw}</td>
            </tr>
            <tr>
              <td style={cell}>All time</td>
              <td style={cell}>{countsAllTime.regression_unmatched}</td>
              <td style={cell}>{countsAllTime.regression_diff}</td>
              <td style={cell}>{countsAllTime.legacy_threw}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ marginBottom: '0.25rem' }}>Recent events ({recent.length})</h2>
        {recent.length === 0 ? (
          <p style={{ color: '#888' }}>
            No regressions yet. (Either parsekit + legacy agree on every input we've seen, or
            the worker hasn't parsed anything since the table was created.)
          </p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={cellHeader}>When</th>
                <th style={cellHeader}>Kind</th>
                <th style={cellHeader}>parserId</th>
                <th style={cellHeader}>Input</th>
                <th style={cellHeader}>Diff / details</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((event) => (
                <tr key={event.id}>
                  <td style={cell}>{formatTimestamp(event.createdAt)}</td>
                  <td style={cell}>
                    <Pill tone={kindTone(event.kind)}>{kindLabel(event.kind)}</Pill>
                  </td>
                  <td style={cell}>
                    <code>{event.parserId ?? '—'}</code>
                    {event.ruleId ? (
                      <>
                        <br />
                        <code style={{ color: '#888' }}>{event.ruleId}</code>
                      </>
                    ) : null}
                  </td>
                  <td style={cell}>
                    <code>{event.input}</code>
                  </td>
                  <td style={cell}>
                    {event.kind === 'regression_diff' && (
                      <>
                        <div>
                          <strong>Differing fields:</strong>{' '}
                          {(event.diffFields ?? []).map((f, i) => (
                            <code key={i} style={{ marginRight: '0.5rem' }}>
                              {f}
                            </code>
                          ))}
                        </div>
                        <details style={{ marginTop: '0.25rem' }}>
                          <summary>parsekit output / legacy output</summary>
                          <div style={{ display: 'flex', gap: '1rem' }}>
                            <pre style={preStyle}>
                              <strong>parsekit:</strong>
                              {'\n'}
                              {renderJson(event.parsekitOutput)}
                            </pre>
                            <pre style={preStyle}>
                              <strong>legacy:</strong>
                              {'\n'}
                              {renderJson(event.legacyOutput)}
                            </pre>
                          </div>
                        </details>
                      </>
                    )}
                    {event.kind === 'regression_unmatched' && (
                      <>
                        <div>
                          <strong>parsekit failure:</strong>{' '}
                          <code>{event.parsekitFailureReason}</code>
                        </div>
                        <details style={{ marginTop: '0.25rem' }}>
                          <summary>legacy output</summary>
                          <pre style={preStyle}>{renderJson(event.legacyOutput)}</pre>
                        </details>
                      </>
                    )}
                    {event.kind === 'legacy_threw' && (
                      <>
                        <div>
                          <strong>legacy error:</strong>{' '}
                          <code>{event.legacyError}</code>
                        </div>
                        <details style={{ marginTop: '0.25rem' }}>
                          <summary>parsekit output</summary>
                          <pre style={preStyle}>{renderJson(event.parsekitOutput)}</pre>
                        </details>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const cellHeader: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: '1px solid #ccc',
  padding: '0.25rem 0.5rem',
  verticalAlign: 'top',
}

const cell: React.CSSProperties = {
  borderBottom: '1px solid #eee',
  padding: '0.25rem 0.5rem',
  verticalAlign: 'top',
}

const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  fontSize: '0.85em',
  background: '#f7f7f7',
  padding: '0.5rem',
  flex: 1,
}
