// SEO → FAQ set editor (P3 control plane).
//
// Author/edit a FAQ set's raw + sanitized variants SIDE BY SIDE, preview
// the FAQPage JSON-LD exactly as the renderer would emit it per host mode
// (no cloaking — the JSON-LD answer equals the visible answer), and drive
// the review/approval lifecycle. Approval is the IRONCLAD human gate
// (canon §1): the editor echoes the exact content fingerprint it loaded
// back to the server so an approval can never cover content that changed
// after load.
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'
import { z } from 'zod'

import {
  SeoFaqSetDetailResponseSchema,
  type SeoFaqItem,
  type SeoFaqSetDetailResponse,
  type SeoFaqSetRecord,
  type SeoFaqStatus,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoFaqEditorLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<SeoFaqSetDetailResponse> {
  return loadJson(`/api/seo/faq-sets/${params.faqSetId}`, SeoFaqSetDetailResponseSchema)
}

const CheckResponseSchema = z.object({ ok: z.boolean(), problems: z.array(z.string()) })

type SeoMode = 'raw' | 'sanitized'

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

// Visible answer for a host mode (single source for preview + JSON-LD so
// they can never disagree — same contract the renderer follows).
function visibleAnswer(item: SeoFaqItem, mode: SeoMode): string {
  return mode === 'raw' ? item.answer_raw : item.answer_sanitized
}

function buildFaqPageJsonLd(items: SeoFaqItem[], mode: SeoMode): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: visibleAnswer(item, mode) },
    })),
  }
}

const EMPTY_ITEM: SeoFaqItem = { question: '', answer_raw: '', answer_sanitized: '' }

export function SeoFaqEditorPage() {
  const data = useLoaderData() as SeoFaqSetDetailResponse
  const revalidator = useRevalidator()
  const record: SeoFaqSetRecord = data.faqSet

  const [scope, setScope] = useState(record.scope)
  const [items, setItems] = useState<SeoFaqItem[]>(record.items)
  const [mode, setMode] = useState<SeoMode>('raw')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)

  // Reset local edit state whenever a fresh record loads (after save /
  // approve / navigation).
  useEffect(() => {
    setScope(record.scope)
    setItems(record.items)
    setNote('')
    setError(null)
  }, [record.faqSetId, record.contentSha256, record.status])

  const dirty = useMemo(
    () => scope !== record.scope || JSON.stringify(items) !== JSON.stringify(record.items),
    [scope, items, record.scope, record.items],
  )

  // Re-run the authoritative server compliance check whenever the saved
  // content changes (so the reviewer sees exactly what approve will block).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await mutateJson('/api/seo/faq-sets/check', CheckResponseSchema, {
          method: 'POST',
          body: JSON.stringify({ scope: record.scope, items: record.items }),
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
  }, [record.faqSetId, record.contentSha256])

  function updateItem(index: number, patch: Partial<SeoFaqItem>) {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  async function run(
    label: string,
    path: string,
    method: string,
    body: unknown,
  ): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await mutateJson(path, SeoFaqSetDetailResponseSchema, {
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

  const save = () =>
    run('Save', `/api/seo/faq-sets/${record.faqSetId}`, 'PUT', { scope, items })
  const submit = () =>
    run('Submit for review', `/api/seo/faq-sets/${record.faqSetId}/submit`, 'POST', {})
  const reject = () =>
    run('Reject', `/api/seo/faq-sets/${record.faqSetId}/reject`, 'POST', { note: note || undefined })
  const approve = () =>
    run('Approve', `/api/seo/faq-sets/${record.faqSetId}/approve`, 'POST', {
      expectedContentSha256: record.contentSha256,
      note: note || undefined,
    })

  const compliant = problems !== null && problems.length === 0
  const canApprove =
    !busy && !dirty && record.status !== 'approved' && items.length > 0 && compliant

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <p style={{ marginTop: 0 }}>
        <Link to="/seo/faq">← All FAQ sets</Link>
      </p>
      <h1 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        FAQ set <Pill tone={statusTone(record.status)}>{record.status}</Pill>
        {dirty && <Pill tone="warning">unsaved changes</Pill>}
      </h1>

      <div className="filter-row wrap-row" style={{ gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Scope
          <input
            type="text"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={busy}
            title="A concrete site id, or the reserved global token 'all'."
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

      {/* Items — raw / sanitized side by side */}
      {items.map((item, index) => (
        <div
          key={index}
          style={{
            border: '1px solid var(--control-border, #d8d8d8)',
            borderRadius: 6,
            padding: 12,
            margin: '12px 0',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Item {index + 1}</strong>
            <button
              type="button"
              onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
              disabled={busy}
            >
              Remove
            </button>
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            Question (shown on BOTH hosts — keep sanitized-safe)
            <input
              type="text"
              value={item.question}
              onChange={(e) => updateItem(index, { question: e.target.value })}
              disabled={busy}
              style={{ width: '100%' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <label style={{ flex: 1 }}>
              Raw answer (FB.nyc)
              <textarea
                value={item.answer_raw}
                onChange={(e) => updateItem(index, { answer_raw: e.target.value })}
                disabled={busy}
                rows={4}
                style={{ width: '100%' }}
              />
            </label>
            <label style={{ flex: 1 }}>
              Sanitized answer (FB.us — no cannabis terms)
              <textarea
                value={item.answer_sanitized}
                onChange={(e) => updateItem(index, { answer_sanitized: e.target.value })}
                disabled={busy}
                rows={4}
                style={{ width: '100%' }}
              />
            </label>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
        disabled={busy}
      >
        + Add item
      </button>

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
        <button type="button" onClick={approve} disabled={!canApprove} title={approveTitle(dirty, compliant, record.status)}>
          Approve
        </button>
      </div>
      {dirty && (
        <p className="subtle-copy" style={{ marginTop: 6 }}>
          Save your changes before approving — approval binds to the exact saved content.
        </p>
      )}

      {/* FAQPage JSON-LD preview (no cloaking — equals the visible answers) */}
      <h2 style={{ marginTop: 24 }}>FAQPage preview ({mode})</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <h3>Rendered</h3>
          {items.map((item, i) => (
            <details key={i} style={{ marginBottom: 6 }}>
              <summary>{item.question || <em>(no question)</em>}</summary>
              <div style={{ padding: '4px 0 0 12px' }}>{visibleAnswer(item, mode)}</div>
            </details>
          ))}
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
            {JSON.stringify(buildFaqPageJsonLd(items, mode), null, 2)}
          </pre>
        </div>
      </div>

      {/* Provenance / debug — collapsed by default per helios page rules. */}
      <details style={{ marginTop: 16 }}>
        <summary>Provenance &amp; debug</summary>
        <dl>
          <dt>FAQ set id</dt>
          <dd>
            <code>{record.faqSetId}</code>
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
                <code>{record.approvalId}</code> by user {record.approvedByUserId} at{' '}
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

function approveTitle(dirty: boolean, compliant: boolean, status: SeoFaqStatus): string {
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
