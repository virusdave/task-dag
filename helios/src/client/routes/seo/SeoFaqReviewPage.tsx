// SEO → FAQ set review page (#46 P5 control plane).
//
// The reviewer/approver's decision surface for one FAQ set. Lands the
// reviewer directly on the evidence: where the set publishes (route
// placement from its source key), the approval BLOCKERS (compliance), the
// advisory governance WARNINGS, and per item the raw (FB.nyc) vs sanitized
// (FB.us) answers with a word-level sanitization diff and inline leak
// markers. Approve / Reject act inline against the same IRONCLAD server
// endpoints the editor uses (canon §1): approval echoes the exact content
// fingerprint loaded so it can never cover content that changed after load.
//
// task dce1a56 (P5) · child FreshlyBakedNYC/automation#46 · Satisfies: virusdave/top-level#17

import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'

import {
  SeoFaqReviewResponseSchema,
  type SeoFaqGovernanceProblem,
  type SeoFaqItem,
  type SeoFaqReviewPlacement,
  type SeoFaqReviewResponse,
  type SeoFaqStatus,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'
import { approveFaqSet, rejectFaqSet } from './seoFaqActions.js'
import { hasSanitizationChange, sanitizationDiff } from './sanitizationDiff.js'

export async function seoFaqReviewLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<SeoFaqReviewResponse> {
  return loadJson(`/api/seo/faq-sets/${params.faqSetId}/review`, SeoFaqReviewResponseSchema)
}

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

function visibleAnswer(item: SeoFaqItem, mode: SeoMode): string {
  return mode === 'raw' ? item.answer_raw : item.answer_sanitized
}

function governanceLabel(p: SeoFaqGovernanceProblem): string {
  const where =
    p.itemIndex < 0
      ? 'Whole set'
      : `Item ${p.itemIndex + 1}${p.field ? ` (${p.field})` : ''}${
          p.relatedItemIndex !== undefined ? ` vs item ${p.relatedItemIndex + 1}` : ''
        }`
  return `${where}: ${p.message}`
}

function complianceLabel(itemIndex: number, field: string, message: string): string {
  return itemIndex < 0 ? message : `Item ${itemIndex + 1} (${field}): ${message}`
}

function placementSummary(placement: SeoFaqReviewPlacement): string {
  switch (placement.kind) {
    case 'lp_family':
      return `LP family "${placement.familyId}" (source key ${placement.sourceKey})`
    case 'non_lp_source_key':
      return `Non-LP source key ${placement.sourceKey} (family slug "${placement.familySlug}"); no LP route patterns`
    case 'unknown_source_key':
      return `Unrecognized source key ${placement.sourceKey}; fails the approval check closed`
    case 'no_source_key':
      return 'No source key. Manual or legacy set, not held to the stricter FBUS rule.'
  }
}

export function SeoFaqReviewPage() {
  const data = useLoaderData() as SeoFaqReviewResponse
  const revalidator = useRevalidator()
  const { faqSet, compliance, governance, sanitizedHostLeakMarkers, placement, preview } = data

  const [mode, setMode] = useState<SeoMode>('sanitized')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset transient state when a fresh record loads (after approve/reject).
  useEffect(() => {
    setNote('')
    setError(null)
  }, [faqSet.faqSetId, faqSet.contentSha256, faqSet.status])

  // Fast lookup of per-field leak markers: `${itemIndex}:${field}`.
  const leakByField = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of sanitizedHostLeakMarkers) {
      map.set(`${m.itemIndex}:${m.field}`, m.markers)
    }
    return map
  }, [sanitizedHostLeakMarkers])

  const blockerCount = compliance.problems.length
  const warningCount = governance.problems.length
  const canApprove =
    !busy && faqSet.status !== 'approved' && faqSet.items.length > 0 && compliance.ok

  async function act(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      revalidator.revalidate()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A 409 means the content changed after this page loaded (stale
      // review). Auto-reload the current version so the reviewer is never
      // left looking at, and able to act on, stale content. fetchJson
      // prefixes the HTTP status to the message ("409: ...").
      if (message.startsWith('409')) {
        setError(`${label} failed: this FAQ set changed. Reloading the current version now.`)
        revalidator.revalidate()
      } else {
        setError(`${label} failed: ${message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const approve = () =>
    act('Approve', () => approveFaqSet(faqSet.faqSetId, faqSet.contentSha256, note))
  // The note field is an approval note; the server does not persist a
  // rejection note, so we do not send one on reject.
  const reject = () => act('Reject', () => rejectFaqSet(faqSet.faqSetId))

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <p style={{ marginTop: 0 }}>
        <Link to="/seo/faq">← All FAQ sets</Link>
      </p>

      {/* Header: status + identity + actions — the decision lives here. */}
      <div
        className="filter-row wrap-row"
        style={{ gap: 12, alignItems: 'center', justifyContent: 'space-between' }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          Review FAQ set <Pill tone={statusTone(faqSet.status)}>{faqSet.status}</Pill>
        </h1>
        <div className="filter-row wrap-row" style={{ gap: 8, alignItems: 'center' }}>
          <Link to={`/seo/faq/${faqSet.faqSetId}`}>Edit in editor</Link>
          <button
            type="button"
            onClick={reject}
            disabled={busy}
            title="Reject this set (clears any approval)."
          >
            Reject
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={!canApprove}
            title={approveTitle(compliance.ok, faqSet.status, faqSet.items.length)}
          >
            Approve
          </button>
        </div>
      </div>

      <p className="subtle-copy" style={{ marginTop: 6 }}>
        Scope <code>{faqSet.scope}</code> · source{' '}
        <code>{faqSet.sourceKey ?? 'none'}</code> · {faqSet.items.length} item
        {faqSet.items.length === 1 ? '' : 's'} · fingerprint{' '}
        <code>{faqSet.contentSha256.slice(0, 12)}…</code>
      </p>

      <div className="filter-row wrap-row" style={{ gap: 12, alignItems: 'center', marginTop: 4 }}>
        <input
          type="text"
          placeholder="Approval note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 240 }}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Preview host mode
          <select value={mode} onChange={(e) => setMode(e.target.value as SeoMode)}>
            <option value="sanitized">sanitized (FB.us)</option>
            <option value="raw">raw (FB.nyc)</option>
          </select>
        </label>
      </div>

      {error && <p style={{ color: 'var(--danger, #b00020)', whiteSpace: 'pre-wrap' }}>{error}</p>}

      {/* Warning summary — primary review evidence, always visible. */}
      <div className="filter-row wrap-row" style={{ gap: 10, alignItems: 'center', margin: '12px 0' }}>
        <Pill tone={blockerCount > 0 ? 'danger' : 'success'}>
          {blockerCount > 0
            ? `${blockerCount} approval blocker${blockerCount === 1 ? '' : 's'}`
            : 'No approval blockers'}
        </Pill>
        <Pill tone={warningCount > 0 ? 'warning' : 'success'}>
          {warningCount > 0
            ? `${warningCount} governance warning${warningCount === 1 ? '' : 's'}`
            : 'No governance warnings'}
        </Pill>
      </div>

      {/* Approval blockers (compliance) — must be empty to approve. */}
      {blockerCount > 0 && (
        <section
          style={{
            border: '1px solid var(--danger, #b00020)',
            borderRadius: 6,
            padding: '8px 12px',
            margin: '12px 0',
          }}
        >
          <strong>Approval blockers (resolve before approving):</strong>
          <ul style={{ margin: '6px 0 0' }}>
            {compliance.problems.map((p, i) => (
              <li key={i}>{complianceLabel(p.itemIndex, p.field, p.message)}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Governance warnings — advisory; reviewer judgment, not a hard gate. */}
      {warningCount > 0 && (
        <section
          style={{
            border: '1px solid var(--warning, #c98a00)',
            borderRadius: 6,
            padding: '8px 12px',
            margin: '12px 0',
          }}
        >
          <strong>Governance warnings (advisory, review before approving):</strong>
          <ul style={{ margin: '6px 0 0' }}>
            {governance.problems.map((p, i) => (
              <li key={i}>{governanceLabel(p)}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Route placement — where this set's FAQs will publish. */}
      <section style={{ margin: '16px 0' }}>
        <h2 style={{ marginBottom: 6 }}>Publishes to</h2>
        <p style={{ marginTop: 0 }}>{placementSummary(placement)}</p>
        {placement.kind === 'lp_family' && (
          <>
            <p style={{ margin: '4px 0' }}>
              Canonical route: <code>{placement.canonicalRepresentativeRoute}</code>
            </p>
            <details>
              <summary>
                Route patterns ({placement.routePatterns.length}) &amp; indexability
              </summary>
              <ul style={{ margin: '6px 0' }}>
                {placement.routePatterns.map((rp) => (
                  <li key={rp}>
                    <code>{rp}</code>
                  </li>
                ))}
              </ul>
              <pre
                style={{
                  background: 'var(--code-bg, #f5f5f5)',
                  padding: 12,
                  borderRadius: 6,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(placement.indexabilityPolicy, null, 2)}
              </pre>
            </details>
          </>
        )}
      </section>

      {/* Items: raw vs sanitized + sanitization diff + leak markers. */}
      <h2 style={{ marginBottom: 6 }}>Items</h2>
      {faqSet.items.length === 0 && <p className="subtle-copy">This set has no items.</p>}
      {faqSet.items.map((item, index) => {
        const diff = sanitizationDiff(item.answer_raw, item.answer_sanitized)
        const questionLeaks = leakByField.get(`${index}:question`)
        const sanitizedLeaks = leakByField.get(`${index}:answer_sanitized`)
        return (
          <div
            key={index}
            style={{
              border: '1px solid var(--control-border, #d8d8d8)',
              borderRadius: 6,
              padding: 12,
              margin: '12px 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>Item {index + 1}</strong>
              {questionLeaks && questionLeaks.length > 0 && (
                <Pill tone="danger">question leak: {questionLeaks.join(', ')}</Pill>
              )}
              {sanitizedLeaks && sanitizedLeaks.length > 0 && (
                <Pill tone="danger">sanitized leak: {sanitizedLeaks.join(', ')}</Pill>
              )}
            </div>
            <p style={{ margin: '8px 0 0' }}>
              <strong>Q:</strong> {item.question || <em>(no question)</em>}
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                <div className="subtle-copy">Raw answer (FB.nyc)</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{item.answer_raw || <em>(empty)</em>}</div>
              </div>
              <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                <div className="subtle-copy">Sanitized answer (FB.us)</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {item.answer_sanitized || <em>(empty)</em>}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="subtle-copy">Sanitization diff (raw → sanitized)</div>
              {hasSanitizationChange(diff) ? (
                <p style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0' }}>
                  {diff.map((seg, i) => (
                    <DiffSpan key={i} kind={seg.kind} text={seg.text} />
                  ))}
                </p>
              ) : (
                <p className="subtle-copy" style={{ margin: '2px 0 0' }}>
                  No change. Sanitized answer is identical to the raw answer.
                </p>
              )}
            </div>
          </div>
        )
      })}

      {/* Repeat the decision controls at the bottom so a reviewer who read a
          long set to the end can act without scrolling back to the header. */}
      {faqSet.items.length > 0 && (
        <div
          className="filter-row wrap-row"
          style={{ gap: 8, alignItems: 'center', marginTop: 16 }}
        >
          <Pill tone={blockerCount > 0 ? 'danger' : 'success'}>
            {blockerCount > 0
              ? `${blockerCount} approval blocker${blockerCount === 1 ? '' : 's'}`
              : 'No approval blockers'}
          </Pill>
          <button type="button" onClick={reject} disabled={busy}>
            Reject
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={!canApprove}
            title={approveTitle(compliance.ok, faqSet.status, faqSet.items.length)}
          >
            Approve
          </button>
        </div>
      )}

      {/* FAQPage JSON-LD preview (no cloaking; equals the visible answers).
          Collapsed by default since the item cards above already show Q/A;
          the unique value here is verifying the emitted schema. */}
      <details style={{ marginTop: 24 }}>
        <summary>
          <strong>FAQPage preview &amp; JSON-LD ({mode})</strong>
        </summary>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            {faqSet.items.map((item, i) => (
              <details key={i} style={{ marginBottom: 6 }}>
                <summary>{item.question || <em>(no question)</em>}</summary>
                <div style={{ padding: '4px 0 0 12px' }}>{visibleAnswer(item, mode)}</div>
              </details>
            ))}
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <pre
              style={{
                background: 'var(--code-bg, #f5f5f5)',
                padding: 12,
                borderRadius: 6,
                overflow: 'auto',
                maxHeight: 360,
              }}
            >
              {JSON.stringify(mode === 'raw' ? preview.rawJsonLd : preview.sanitizedJsonLd, null, 2)}
            </pre>
          </div>
        </div>
      </details>

      {/* Provenance / debug, collapsed by default per helios page rules. */}
      <details style={{ marginTop: 16 }}>
        <summary>Provenance &amp; debug</summary>
        <dl>
          <dt>FAQ set id</dt>
          <dd>
            <code>{faqSet.faqSetId}</code>
          </dd>
          <dt>Content fingerprint</dt>
          <dd>
            <code>{faqSet.contentSha256}</code>
          </dd>
          <dt>Source</dt>
          <dd>{faqSet.source}</dd>
          {faqSet.approvalId && (
            <>
              <dt>Approval</dt>
              <dd>
                <code>{faqSet.approvalId}</code> by user {faqSet.approvedByUserId} at{' '}
                {faqSet.approvedAt ? nyLongDateTime(Date.parse(faqSet.approvedAt)) : 'unknown time'}
                {faqSet.approvalNote ? `, note: "${faqSet.approvalNote}"` : ''}
              </dd>
            </>
          )}
        </dl>
      </details>
    </div>
  )
}

function DiffSpan({ kind, text }: { kind: 'equal' | 'removed' | 'added'; text: string }) {
  if (kind === 'equal') {
    return <span>{text} </span>
  }
  const style =
    kind === 'removed'
      ? { background: 'rgba(176, 0, 32, 0.14)', textDecoration: 'line-through' as const }
      : { background: 'rgba(0, 128, 0, 0.16)' }
  return <span style={style}>{text} </span>
}

function approveTitle(complianceOk: boolean, status: SeoFaqStatus, itemCount: number): string {
  if (status === 'approved') {
    return 'Already approved.'
  }
  if (itemCount === 0) {
    return 'This set has no items.'
  }
  if (!complianceOk) {
    return 'Resolve the approval blockers first.'
  }
  return 'Approve this exact content (IRONCLAD human gate).'
}
