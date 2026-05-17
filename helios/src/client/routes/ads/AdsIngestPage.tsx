import { useState } from 'react'

import {
  ADS_DRIVE_FOLDER_URL,
  AdsIngestResponseSchema,
  type AdsIngestResponse,
} from '../../../shared/contracts/index.js'
import { mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'

type Status =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; result: AdsIngestResponse }
  | { kind: 'err'; message: string }

export function AdsIngestPage() {
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) {
      setStatus({ kind: 'err', message: 'Paste a Drive file URL or ID first.' })
      return
    }
    setStatus({ kind: 'running' })
    try {
      const result = await mutateJson('/api/ads/ingest', AdsIngestResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ driveFileUrlOrId: trimmed }),
      })
      setStatus({ kind: 'ok', result })
    } catch (err) {
      setStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Ads &rsaquo; Ingest</p>
          <h2>Ingest latest from Google Drive</h2>
          <p className="subtle-copy">
            Pull the latest Google Ads Editor export from the canonical Drive folder,
            rebuild the snapshot + recovery bundle, and re-deploy the experiments
            dashboard. The whole pipeline takes well under a minute.
          </p>
        </div>
        <Pill tone={status.kind === 'running' ? 'warning' : 'success'}>
          {status.kind === 'running' ? 'running' : 'ready'}
        </Pill>
      </div>

      <article className="detail-panel">
        <header className="page-header">
          <h3>One-click ingest</h3>
        </header>
        <p className="subtle-copy">
          Source folder:{' '}
          <a href={ADS_DRIVE_FOLDER_URL} target="_blank" rel="noreferrer">
            Google Ads exports on Drive
          </a>
          . Open the newest file there, make sure it's shared
          &quot;Anyone with the link can view&quot;, copy the file URL or just the
          ID, paste it below, click the button.
        </p>

        <form onSubmit={submit} className="inline-row wrap-row" style={{ gap: 12, marginTop: 12 }}>
          <input
            type="text"
            placeholder="https://drive.google.com/file/d/<ID>/view  (or just the ID)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={status.kind === 'running'}
            style={{ flex: '1 1 360px', minWidth: 280, padding: '8px 10px' }}
          />
          <button type="submit" disabled={status.kind === 'running'}>
            {status.kind === 'running'
              ? 'Ingesting…'
              : 'Ingest latest from Google Drive'}
          </button>
        </form>

        {status.kind === 'running' ? (
          <p className="subtle-copy" style={{ marginTop: 12 }}>
            Downloading from Drive, rebuilding snapshot, regenerating bundle,
            uploading to the public oauth proxy. Keep this tab open until the new
            URL appears.
          </p>
        ) : null}

        {status.kind === 'ok' ? (
          <div className="detail-panel" style={{ marginTop: 16, borderColor: 'var(--ok, #2a8c4a)' }}>
            <h4 style={{ marginTop: 0 }}>✅ Ingest complete</h4>
            <p>
              New public URL:{' '}
              <a href={status.result.publicUrl} target="_blank" rel="noreferrer">
                {status.result.publicUrl}
              </a>
            </p>
            <p className="subtle-copy" style={{ marginBottom: 0 }}>
              Source file ID: <code>{status.result.sourceFileId}</code>
              <br />
              Snapshot: <code>{status.result.snapshotPath}</code>
              <br />
              HTML: <code>{status.result.outputPath}</code>
            </p>
          </div>
        ) : null}

        {status.kind === 'err' ? (
          <div className="detail-panel" style={{ marginTop: 16, borderColor: 'var(--bad, #b22)' }}>
            <h4 style={{ marginTop: 0 }}>⚠ Ingest failed</h4>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{status.message}</pre>
          </div>
        ) : null}
      </article>
    </section>
  )
}
