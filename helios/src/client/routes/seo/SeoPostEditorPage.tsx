// SEO → Blog post editor (P4 auto-blog control plane).
//
// Author/edit a "What's new" post — shared title/meta/excerpt/tags/slug
// plus the raw (FB.nyc) + sanitized (FB.us) body SIDE BY SIDE — preview the
// BlogPosting JSON-LD exactly as the renderer would emit it per host mode
// (no cloaking — articleBody equals the visible body), and drive the
// review/approval lifecycle. Approval is the IRONCLAD human gate (canon §1):
// the editor echoes the exact content fingerprint it loaded back to the
// server so an approval can never cover content that changed after load.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'
import { z } from 'zod'

import {
  SeoPostDetailResponseSchema,
  type SeoPostDetailResponse,
  type SeoPostRecord,
  type SeoPostStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoPostEditorLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<SeoPostDetailResponse> {
  return loadJson(`/api/seo/posts/${params.postId}`, SeoPostDetailResponseSchema)
}

const CheckResponseSchema = z.object({ ok: z.boolean(), problems: z.array(z.string()) })

type SeoMode = 'raw' | 'sanitized'

// The editable content fields the editor tracks locally.
interface PostDraft {
  scope: string
  slug: string
  title: string
  metaDescription: string
  excerpt: string
  author: string
  tagsText: string
  bodyRaw: string
  bodySanitized: string
  noindex: boolean
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

function tagsToText(tags: string[]): string {
  return tags.join(', ')
}

function textToTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function draftFromRecord(record: SeoPostRecord): PostDraft {
  return {
    scope: record.scope,
    slug: record.slug,
    title: record.title,
    metaDescription: record.metaDescription,
    excerpt: record.excerpt,
    author: record.author,
    tagsText: tagsToText(record.tags),
    bodyRaw: record.bodyRaw,
    bodySanitized: record.bodySanitized,
    noindex: record.noindex,
  }
}

function draftToBody(d: PostDraft): Record<string, unknown> {
  return {
    scope: d.scope,
    slug: d.slug,
    title: d.title,
    metaDescription: d.metaDescription,
    excerpt: d.excerpt,
    author: d.author,
    tags: textToTags(d.tagsText),
    bodyRaw: d.bodyRaw,
    bodySanitized: d.bodySanitized,
    noindex: d.noindex,
  }
}

function visibleBody(d: PostDraft, mode: SeoMode): string {
  return mode === 'raw' ? d.bodyRaw : d.bodySanitized
}

// Single source of truth for the BlogPosting JSON-LD preview, mirroring the
// server's buildBlogPostJsonLd so the preview can never drift from what the
// renderer would emit (articleBody === visible body for the chosen mode).
function buildBlogPostJsonLd(
  d: PostDraft,
  canonicalUrl: string,
  publishedAt: string,
  mode: SeoMode,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: d.title,
    description: d.metaDescription,
    articleBody: visibleBody(d, mode),
    datePublished: publishedAt,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    author: { '@type': 'Organization', name: d.author },
    keywords: textToTags(d.tagsText),
  }
}

export function SeoPostEditorPage() {
  const data = useLoaderData() as SeoPostDetailResponse
  const revalidator = useRevalidator()
  const record: SeoPostRecord = data.post

  const [draft, setDraft] = useState<PostDraft>(() => draftFromRecord(record))
  const [mode, setMode] = useState<SeoMode>('raw')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)

  // Reset local edit state whenever a fresh record loads (after save /
  // approve / navigation).
  useEffect(() => {
    setDraft(draftFromRecord(record))
    setNote('')
    setError(null)
  }, [record.postId, record.contentSha256, record.status])

  const savedDraft = useMemo(() => draftFromRecord(record), [record])
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedDraft),
    [draft, savedDraft],
  )

  // Re-run the authoritative server compliance check whenever the saved
  // content changes (so the reviewer sees exactly what approve will block).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await mutateJson('/api/seo/posts/check', CheckResponseSchema, {
          method: 'POST',
          body: JSON.stringify(draftToBody(savedDraft)),
        })
        if (!cancelled) {
          setProblems(res.problems)
        }
      } catch {
        if (!cancelled) {
          setProblems(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [record.postId, record.contentSha256, savedDraft])

  function patch(p: Partial<PostDraft>) {
    setDraft((prev) => ({ ...prev, ...p }))
  }

  async function run(label: string, path: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await mutateJson(path, SeoPostDetailResponseSchema, {
        method,
        body: JSON.stringify(body ?? {}),
      })
      revalidator.revalidate()
      return true
    } catch (e) {
      setError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = () => run('Save', `/api/seo/posts/${record.postId}`, 'PUT', draftToBody(draft))
  const submit = () => run('Submit for review', `/api/seo/posts/${record.postId}/submit`, 'POST', {})
  const reject = () =>
    run('Reject', `/api/seo/posts/${record.postId}/reject`, 'POST', { note: note || undefined })
  const approve = () =>
    run('Approve', `/api/seo/posts/${record.postId}/approve`, 'POST', {
      expectedContentSha256: record.contentSha256,
      note: note || undefined,
    })

  const compliant = problems !== null && problems.length === 0
  const canApprove = !busy && !dirty && record.status !== 'approved' && compliant

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <p style={{ marginTop: 0 }}>
        <Link to="/seo/posts">← All posts</Link>
      </p>
      <h1 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        Blog post <Pill tone={statusTone(record.status)}>{record.status}</Pill>
        {dirty && <Pill tone="warning">unsaved changes</Pill>}
      </h1>

      <div className="filter-row wrap-row" style={{ gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Scope
          <input
            type="text"
            value={draft.scope}
            onChange={(e) => patch({ scope: e.target.value })}
            disabled={busy}
            title="A concrete site id, or the reserved global token 'all'."
            style={{ width: 160 }}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Slug
          <input
            type="text"
            value={draft.slug}
            onChange={(e) => patch({ slug: e.target.value })}
            disabled={busy}
            title="Lowercase kebab-case. URL: /sites/<scope>/whats-new/<slug>"
            style={{ width: 220 }}
          />
        </label>
        <span style={{ opacity: 0.5 }}>|</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Preview host mode
          <select value={mode} onChange={(e) => setMode(e.target.value as SeoMode)}>
            <option value="raw">raw (FB.nyc)</option>
            <option value="sanitized">sanitized (FB.us)</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.noindex}
            onChange={(e) => patch({ noindex: e.target.checked })}
            disabled={busy}
          />
          noindex
        </label>
      </div>

      {error && (
        <p style={{ color: 'var(--danger, #b00020)', whiteSpace: 'pre-wrap' }}>{error}</p>
      )}

      {problems !== null && problems.length > 0 && (
        <div
          style={{
            border: '1px solid var(--warning, #c98a00)',
            borderRadius: 6,
            padding: '8px 12px',
            margin: '12px 0',
          }}
        >
          <strong>Not approvable yet — fix these:</strong>
          <ul style={{ margin: '6px 0 0' }}>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <label style={{ display: 'block', marginTop: 12 }}>
        Title (shown on BOTH hosts — keep sanitized-safe)
        <input
          type="text"
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          disabled={busy}
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        Meta description (≤160 chars; both hosts)
        <input
          type="text"
          value={draft.metaDescription}
          onChange={(e) => patch({ metaDescription: e.target.value })}
          disabled={busy}
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        Excerpt (both hosts)
        <textarea
          value={draft.excerpt}
          onChange={(e) => patch({ excerpt: e.target.value })}
          disabled={busy}
          rows={2}
          style={{ width: '100%' }}
        />
      </label>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <label style={{ flex: 1 }}>
          Author (byline)
          <input
            type="text"
            value={draft.author}
            onChange={(e) => patch({ author: e.target.value })}
            disabled={busy}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ flex: 2 }}>
          Tags (comma-separated; both hosts)
          <input
            type="text"
            value={draft.tagsText}
            onChange={(e) => patch({ tagsText: e.target.value })}
            disabled={busy}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      {/* Body — raw / sanitized side by side */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <label style={{ flex: 1 }}>
          Raw body (FB.nyc)
          <textarea
            value={draft.bodyRaw}
            onChange={(e) => patch({ bodyRaw: e.target.value })}
            disabled={busy}
            rows={12}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ flex: 1 }}>
          Sanitized body (FB.us — no cannabis terms)
          <textarea
            value={draft.bodySanitized}
            onChange={(e) => patch({ bodySanitized: e.target.value })}
            disabled={busy}
            rows={12}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      {/* Lifecycle controls */}
      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', marginTop: 20 }}
      >
        <button type="button" onClick={save} disabled={busy || !dirty}>
          Save changes
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || dirty || record.status === 'approved'}
        >
          Submit for review
        </button>
        <input
          type="text"
          placeholder="Approval / rejection note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button type="button" onClick={reject} disabled={busy || dirty}>
          Reject
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={!canApprove}
          title={approveTitle(dirty, compliant, record.status)}
        >
          Approve
        </button>
      </div>
      {dirty && (
        <p className="subtle-copy" style={{ marginTop: 6 }}>
          Save your changes before approving — approval binds to the exact saved content.
        </p>
      )}

      {/* BlogPosting JSON-LD preview (no cloaking — equals the visible body) */}
      <h2 style={{ marginTop: 24 }}>BlogPosting preview ({mode})</h2>
      <p className="subtle-copy" style={{ marginTop: 0 }}>
        Canonical: <code>{record.canonicalUrl || '(set a valid slug)'}</code>
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <h3>Rendered</h3>
          <h4 style={{ marginBottom: 4 }}>{draft.title || <em>(no title)</em>}</h4>
          <p className="subtle-copy" style={{ marginTop: 0 }}>{draft.excerpt}</p>
          <div style={{ whiteSpace: 'pre-wrap' }}>{visibleBody(draft, mode)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 320 }}>
          <h3>JSON-LD</h3>
          <pre
            style={{
              background: 'var(--code-bg, #f5f5f5)',
              padding: 12,
              borderRadius: 6,
              overflow: 'auto',
              maxHeight: 360,
            }}
          >
            {JSON.stringify(
              buildBlogPostJsonLd(draft, record.canonicalUrl, record.publishedAt, mode),
              null,
              2,
            )}
          </pre>
        </div>
      </div>

      {/* Provenance / debug — collapsed by default per helios page rules. */}
      <details style={{ marginTop: 16 }}>
        <summary>Provenance &amp; debug</summary>
        <dl>
          <dt>Post id</dt>
          <dd>
            <code>{record.postId}</code>
          </dd>
          <dt>Content fingerprint</dt>
          <dd>
            <code>{record.contentSha256}</code>
          </dd>
          <dt>Source</dt>
          <dd>{record.source}</dd>
          {record.approvalId && (
            <>
              <dt>Approval</dt>
              <dd>
                <code>{record.approvalId}</code> by {record.reviewer ?? '—'} (user{' '}
                {record.approvedByUserId}) at{' '}
                {record.approvedAt ? nyLongDateTime(Date.parse(record.approvedAt)) : '—'}
                {record.approvalNote ? ` — “${record.approvalNote}”` : ''}
              </dd>
            </>
          )}
          {record.generationMeta != null && (
            <>
              <dt>Generation metadata</dt>
              <dd>
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(record.generationMeta, null, 2)}
                </pre>
              </dd>
            </>
          )}
        </dl>
      </details>
    </div>
  )
}

function approveTitle(dirty: boolean, compliant: boolean, status: SeoPostStatus): string {
  if (status === 'approved') {
    return 'Already approved.'
  }
  if (dirty) {
    return 'Save your changes first.'
  }
  if (!compliant) {
    return 'Resolve the compliance problems first.'
  }
  return 'Approve this exact content (IRONCLAD human gate).'
}
