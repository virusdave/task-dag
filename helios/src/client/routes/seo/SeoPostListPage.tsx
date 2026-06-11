// SEO → Blog posts list (P4 auto-blog control plane).
//
// Lists every authored/generated post with its review status, and lets an
// editor start a new post (manually or via Bedrock generation). Approval —
// the IRONCLAD human gate — happens in the per-post editor.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { useState } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'

import {
  SeoPostDetailResponseSchema,
  SeoPostListResponseSchema,
  type SeoPostListResponse,
  type SeoPostStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoPostListLoader(): Promise<SeoPostListResponse> {
  return loadJson('/api/seo/posts', SeoPostListResponseSchema)
}

function statusTone(status: SeoPostStatus): PillProps['tone'] {
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

export function SeoPostListPage() {
  const data = useLoaderData() as SeoPostListResponse
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [topic, setTopic] = useState('')

  async function createBlank() {
    setBusy(true)
    setError(null)
    try {
      const res = await mutateJson('/api/seo/posts', SeoPostDetailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ scope: 'all' }),
      })
      navigate(`/seo/posts/${res.post.postId}`)
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
      const res = await mutateJson('/api/seo/posts/generate', SeoPostDetailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ topic: topic.trim() }),
      })
      navigate(`/seo/posts/${res.post.postId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <h1 style={{ marginTop: 0 }}>SEO · Blog posts</h1>

      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', marginBottom: 16 }}
      >
        <button type="button" onClick={createBlank} disabled={busy}>
          + New post
        </button>
        <span style={{ opacity: 0.5 }}>or</span>
        <input
          type="text"
          placeholder="Generate from a topic, e.g. 'summer rooftop events in Brooklyn'"
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

      {data.posts.length === 0 ? (
        <p className="subtle-copy">No posts yet. Create one or generate a draft.</p>
      ) : (
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Title</th>
              <th style={{ textAlign: 'left' }}>Scope</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Source</th>
              <th style={{ textAlign: 'left' }}>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.posts.map((p) => (
              <tr key={p.postId}>
                <td>{p.title || <em>(untitled)</em>}</td>
                <td>{p.scope}</td>
                <td>
                  <Pill tone={statusTone(p.status)}>{p.status}</Pill>
                </td>
                <td>{p.source}</td>
                <td>{fmt(p.updatedAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/seo/posts/${p.postId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
