// SEO → FAQ sets list (P3 control plane).
//
// Lists every authored/generated FAQ set with its review status, and lets
// an editor start a new set (manually or via Bedrock generation). Approval
// — the IRONCLAD human gate — happens in the per-set editor.
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

import { useState } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'

import {
  SeoFaqSetDetailResponseSchema,
  SeoFaqSetListResponseSchema,
  type SeoFaqSetListResponse,
  type SeoFaqStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoFaqListLoader(): Promise<SeoFaqSetListResponse> {
  return loadJson('/api/seo/faq-sets', SeoFaqSetListResponseSchema)
}

function statusTone(status: SeoFaqStatus): PillProps['tone'] {
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

export function SeoFaqListPage() {
  const data = useLoaderData() as SeoFaqSetListResponse
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topic, setTopic] = useState('')

  async function createBlank() {
    setBusy(true)
    setError(null)
    try {
      const res = await mutateJson('/api/seo/faq-sets', SeoFaqSetDetailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ scope: 'all', items: [] }),
      })
      navigate(`/seo/faq/${res.faqSet.faqSetId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function generate() {
    if (topic.trim().length < 3) {
      setError('Enter a topic (at least 3 characters) to generate from.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await mutateJson('/api/seo/faq-sets/generate', SeoFaqSetDetailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim(), itemCount: 5 }),
      })
      navigate(`/seo/faq/${res.faqSet.faqSetId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>SEO · FAQ sets</h1>

      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', marginBottom: 16 }}
      >
        <button type="button" onClick={createBlank} disabled={busy}>
          + New FAQ set
        </button>
        <span style={{ opacity: 0.5 }}>or</span>
        <input
          type="text"
          placeholder="Generate from a topic, e.g. 'first-time customer questions'"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 320 }}
        />
        <button type="button" onClick={generate} disabled={busy}>
          Generate draft with AI
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

      {data.faqSets.length === 0 ? (
        <p className="subtle-copy">No FAQ sets yet. Create one or generate a draft.</p>
      ) : (
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Scope</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Source</th>
              <th style={{ textAlign: 'right' }}>Items</th>
              <th style={{ textAlign: 'left' }}>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.faqSets.map((s) => (
              <tr key={s.faqSetId}>
                <td>{s.scope}</td>
                <td>
                  <Pill tone={statusTone(s.status)}>{s.status}</Pill>
                </td>
                <td>{s.source}</td>
                <td style={{ textAlign: 'right' }}>{s.items.length}</td>
                <td>{fmt(s.updatedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/seo/faq/${s.faqSetId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
