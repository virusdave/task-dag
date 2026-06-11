// SEO → Image assets list (P4 auto-blog control plane — independent images).
//
// Lists every registered SEO image asset with its review status, and lets an
// editor register a new one. Images are approved INDEPENDENTLY of posts; an
// approved asset can later be referenced by a post. Approval — the IRONCLAD
// human gate — happens in the per-asset editor.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { useState } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'

import {
  SeoImageAssetDetailResponseSchema,
  SeoImageAssetListResponseSchema,
  type SeoImageAssetListResponse,
  type SeoImageAssetStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoImageAssetListLoader(): Promise<SeoImageAssetListResponse> {
  return loadJson('/api/seo/image-assets', SeoImageAssetListResponseSchema)
}

function statusTone(status: SeoImageAssetStatus): PillProps['tone'] {
  switch (status) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'needs_review':
      return 'warning'
    case 'draft':
      return 'muted'
  }
}

function fmt(value: string): string {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value : nyShortDateTime(ms)
}

function shortSha(sha: string): string {
  return sha ? `${sha.slice(0, 12)}…` : '(none yet)'
}

export function SeoImageAssetListPage() {
  const data = useLoaderData() as SeoImageAssetListResponse
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function createBlank() {
    setBusy(true)
    setError(null)
    try {
      const res = await mutateJson('/api/seo/image-assets', SeoImageAssetDetailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      navigate(`/seo/images/${res.asset.assetId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>SEO · Image assets</h1>

      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', marginBottom: 16 }}
      >
        <button type="button" onClick={createBlank} disabled={busy}>
          + New image asset
        </button>
        <button
          type="button"
          onClick={() => revalidator.revalidate()}
          disabled={busy || revalidator.state === 'loading'}
        >
          Refresh
        </button>
      </div>

      {error && (
        <p style={{ color: 'var(--danger, #b00020)', whiteSpace: 'pre-wrap' }}>{error}</p>
      )}

      {data.assets.length === 0 ? (
        <p className="subtle-copy">
          No image assets yet. Register one (its bytes are hosted by the renderer; Helios records
          the content hash + metadata and the approval).
        </p>
      ) : (
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Alt text</th>
              <th style={{ textAlign: 'left' }}>Role</th>
              <th style={{ textAlign: 'left' }}>Content hash</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Source</th>
              <th style={{ textAlign: 'left' }}>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.assets.map((a) => (
              <tr key={a.assetId}>
                <td>{a.altText || <em>(no alt text)</em>}</td>
                <td>{a.role}</td>
                <td>
                  <code>{shortSha(a.assetSha256)}</code>
                </td>
                <td>
                  <Pill tone={statusTone(a.status)}>{a.status}</Pill>
                </td>
                <td>{a.source}</td>
                <td>{fmt(a.updatedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/seo/images/${a.assetId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
