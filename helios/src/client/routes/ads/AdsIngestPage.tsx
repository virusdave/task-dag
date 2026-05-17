import { useCallback, useEffect, useState } from 'react'

import {
  ADS_DRIVE_FOLDER_URL,
  AdsIngestResponseSchema,
  AdsStatusResponseSchema,
  type AdsIngestResponse,
  type AdsStatusResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { COMMUNICATIONS_SIDEBAR_SUBTREE } from '../communications/communicationsSidebar.js'

type Op =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; result: AdsIngestResponse }
  | { kind: 'err'; message: string }

const STATUS_POLL_MS = 10_000

export function AdsIngestPage() {
  useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)
  const [status, setStatus] = useState<AdsStatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [op, setOp] = useState<Op>({ kind: 'idle' })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [manualInput, setManualInput] = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const next = await loadJson('/api/ads/status', AdsStatusResponseSchema)
      setStatus(next)
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
    const id = setInterval(() => {
      void fetchStatus()
    }, STATUS_POLL_MS)
    return () => clearInterval(id)
  }, [fetchStatus])

  const runIngest = useCallback(
    async (driveFileUrlOrId?: string) => {
      setOp({ kind: 'running' })
      try {
        const result = await mutateJson('/api/ads/ingest', AdsIngestResponseSchema, {
          method: 'POST',
          body: JSON.stringify(driveFileUrlOrId ? { driveFileUrlOrId } : {}),
        })
        setOp({ kind: 'ok', result })
        void fetchStatus()
      } catch (err) {
        setOp({ kind: 'err', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [fetchStatus],
  )

  const onIngestAuto = (event: React.FormEvent) => {
    event.preventDefault()
    void runIngest()
  }
  const onIngestManual = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = manualInput.trim()
    if (!trimmed) {
      setOp({ kind: 'err', message: 'Paste a Drive file URL or ID first.' })
      return
    }
    void runIngest(trimmed)
  }

  const headerTone =
    op.kind === 'running' || status?.running ? 'warning' :
    status && status.configured ? 'success' :
    'warning'
  const headerLabel =
    op.kind === 'running' || status?.running ? 'running' :
    status && status.configured ? 'auto-watching' :
    'manual only'

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Ads &rsaquo; Drive ingest</p>
          <h2>Google Drive auto-ingest</h2>
          <p className="subtle-copy">
            Helios polls the{' '}
            <a href={ADS_DRIVE_FOLDER_URL} target="_blank" rel="noreferrer">
              canonical Drive folder
            </a>{' '}
            every 30s. When the newest CSV changes, the snapshot + recovery
            bundle are rebuilt and the public experiments dashboard is re-deployed
            automatically. Use the "Ingest now" button to force a check.
          </p>
        </div>
        <Pill tone={headerTone}>{headerLabel}</Pill>
      </div>

      {status && !status.configured ? (
        <article className="detail-panel" style={{ borderColor: 'var(--warn, #b87b00)' }}>
          <h4 style={{ marginTop: 0 }}>⚙ Drive auto-discovery not configured</h4>
          <p>{status.reason ?? 'Unknown reason.'}</p>
          <p className="subtle-copy" style={{ marginBottom: 0 }}>
            See <code>ads/google/docs/HELIOS_EXPORT_SOURCE.md</code> for how to mint
            a read-only Drive API key and place it at
            <code>~/.secret/google-drive/api-key</code>. Manual paste below still
            works while you set this up.
          </p>
        </article>
      ) : null}

      <article className="detail-panel">
        <header className="page-header">
          <h3>Auto-ingest status</h3>
          <button type="button" className="ghost-button" onClick={onIngestAuto} disabled={op.kind === 'running'}>
            {op.kind === 'running' || status?.running ? 'Ingesting…' : 'Ingest now'}
          </button>
        </header>

        {statusError ? (
          <p className="subtle-copy" style={{ color: 'var(--bad, #b22)' }}>
            Couldn't fetch status: {statusError}
          </p>
        ) : null}

        {status ? (
          <dl className="kv-grid" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
            <dt>Latest in Drive</dt>
            <dd>
              {status.latestDiscoveredFile ? (
                <>
                  {status.latestDiscoveredFile.webViewLink ? (
                    <a href={status.latestDiscoveredFile.webViewLink} target="_blank" rel="noreferrer">
                      {status.latestDiscoveredFile.name}
                    </a>
                  ) : (
                    <span>{status.latestDiscoveredFile.name}</span>
                  )}{' '}
                  <span className="subtle-copy">
                    (modified {formatTime(status.latestDiscoveredFile.modifiedTime)})
                  </span>
                </>
              ) : (
                <span className="subtle-copy">—</span>
              )}
            </dd>

            <dt>Last ingested</dt>
            <dd>
              {status.lastIngestedFileId ? (
                <>
                  <code>{status.lastIngestedFileId}</code>{' '}
                  <span className="subtle-copy">
                    {status.lastSuccessAt ? `at ${formatTime(status.lastSuccessAt)}` : ''}
                  </span>
                </>
              ) : (
                <span className="subtle-copy">never</span>
              )}
            </dd>

            <dt>Current public URL</dt>
            <dd>
              {status.lastPublicUrl ? (
                <a href={status.lastPublicUrl} target="_blank" rel="noreferrer">
                  {status.lastPublicUrl}
                </a>
              ) : (
                <span className="subtle-copy">—</span>
              )}
            </dd>

            <dt>Last poll</dt>
            <dd className="subtle-copy">{status.lastCheckedAt ? formatTime(status.lastCheckedAt) : 'pending first poll'}</dd>
          </dl>
        ) : (
          <p className="subtle-copy">Loading status…</p>
        )}

        {status?.lastError ? (
          <div className="detail-panel" style={{ marginTop: 12, borderColor: 'var(--bad, #b22)' }}>
            <h4 style={{ marginTop: 0 }}>Last error</h4>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{status.lastError}</pre>
          </div>
        ) : null}

        {op.kind === 'ok' ? (
          <div className="detail-panel" style={{ marginTop: 16, borderColor: 'var(--ok, #2a8c4a)' }}>
            <h4 style={{ marginTop: 0 }}>✅ Manual run complete</h4>
            <p>
              <a href={op.result.publicUrl} target="_blank" rel="noreferrer">
                {op.result.publicUrl}
              </a>
            </p>
          </div>
        ) : null}

        {op.kind === 'err' ? (
          <div className="detail-panel" style={{ marginTop: 16, borderColor: 'var(--bad, #b22)' }}>
            <h4 style={{ marginTop: 0 }}>⚠ Manual run failed</h4>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{op.message}</pre>
          </div>
        ) : null}
      </article>

      <article className="detail-panel" style={{ marginTop: 16 }}>
        <header className="page-header">
          <h3>Advanced: ingest a specific Drive file</h3>
          <button type="button" className="ghost-button" onClick={() => setShowAdvanced((x) => !x)}>
            {showAdvanced ? 'hide' : 'show'}
          </button>
        </header>
        {showAdvanced ? (
          <>
            <p className="subtle-copy">
              Bypass auto-discovery and ingest a specific file (URL or raw ID).
              Useful when the auto-pick chose the wrong file or you want to test
              an older export.
            </p>
            <form onSubmit={onIngestManual} className="inline-row wrap-row" style={{ gap: 12, marginTop: 12 }}>
              <input
                type="text"
                placeholder="https://drive.google.com/file/d/<ID>/view  (or just the ID)"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                disabled={op.kind === 'running'}
                style={{ flex: '1 1 360px', minWidth: 280, padding: '8px 10px' }}
              />
              <button type="submit" disabled={op.kind === 'running'}>
                {op.kind === 'running' ? 'Ingesting…' : 'Ingest this file'}
              </button>
            </form>
          </>
        ) : null}
      </article>
    </section>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = Date.now()
    const diff = Math.round((now - d.getTime()) / 1000)
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
    return d.toLocaleString()
  } catch {
    return iso
  }
}
