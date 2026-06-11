// SEO → Image-asset editor (P4 auto-blog control plane — independent images).
//
// Register/edit an SEO image asset's metadata — the content hash (sha256) of
// the image bytes (hosted by the renderer), its role (hero / og /
// derivative), media type, intrinsic dimensions, and the accessible alt text
// (rendered on BOTH hosts, so it must be sanitized-safe) — and drive the
// review/approval lifecycle. Approval is the IRONCLAD human gate (canon §1):
// the editor echoes the exact content fingerprint it loaded back to the
// server so an approval can never cover metadata that changed after load.
// Images are approved INDEPENDENTLY of any post (parent EPIC_PLAN §0.3).
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useRevalidator } from 'react-router-dom'
import { z } from 'zod'

import {
  SeoImageAssetDetailResponseSchema,
  type SeoImageAssetDetailResponse,
  type SeoImageAssetRecord,
  type SeoImageAssetStatus,
  type SeoImageRole,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { Pill, type PillProps } from '../../components/Pill.js'

export async function seoImageAssetEditorLoader({
  params,
}: {
  params: Record<string, string | undefined>
}): Promise<SeoImageAssetDetailResponse> {
  return loadJson(`/api/seo/image-assets/${params.assetId}`, SeoImageAssetDetailResponseSchema)
}

const CheckResponseSchema = z.object({ ok: z.boolean(), problems: z.array(z.string()) })

const ROLES: readonly SeoImageRole[] = ['hero', 'og', 'derivative']

// The editable metadata fields the editor tracks locally (dimensions as
// strings so an empty input maps cleanly to "no dimension").
interface AssetDraft {
  assetSha256: string
  role: SeoImageRole
  mediaType: string
  widthText: string
  heightText: string
  altText: string
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

function dimToText(value: number | null): string {
  return value === null ? '' : String(value)
}

function textToDim(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return null
  }
  const n = Number.parseInt(trimmed, 10)
  return Number.isFinite(n) ? n : null
}

function draftFromRecord(record: SeoImageAssetRecord): AssetDraft {
  return {
    assetSha256: record.assetSha256,
    role: record.role,
    mediaType: record.mediaType,
    widthText: dimToText(record.width),
    heightText: dimToText(record.height),
    altText: record.altText,
  }
}

function draftToBody(d: AssetDraft): Record<string, unknown> {
  return {
    assetSha256: d.assetSha256.trim(),
    role: d.role,
    mediaType: d.mediaType.trim(),
    width: textToDim(d.widthText),
    height: textToDim(d.heightText),
    altText: d.altText,
  }
}

export function SeoImageAssetEditorPage() {
  const data = useLoaderData() as SeoImageAssetDetailResponse
  const revalidator = useRevalidator()
  const record: SeoImageAssetRecord = data.asset

  const [draft, setDraft] = useState<AssetDraft>(() => draftFromRecord(record))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[] | null>(null)

  // Reset local edit state whenever a fresh record loads.
  useEffect(() => {
    setDraft(draftFromRecord(record))
    setNote('')
    setError(null)
  }, [record.assetId, record.contentSha256, record.status])

  const savedDraft = useMemo(() => draftFromRecord(record), [record])
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedDraft),
    [draft, savedDraft],
  )

  // Re-run the authoritative server compliance check whenever the saved
  // metadata changes (so the reviewer sees exactly what approve will block).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await mutateJson('/api/seo/image-assets/check', CheckResponseSchema, {
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
  }, [record.assetId, record.contentSha256, savedDraft])

  function patch(p: Partial<AssetDraft>) {
    setDraft((prev) => ({ ...prev, ...p }))
  }

  async function run(label: string, path: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await mutateJson(path, SeoImageAssetDetailResponseSchema, {
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
    run('Save', `/api/seo/image-assets/${record.assetId}`, 'PUT', draftToBody(draft))
  const submit = () =>
    run('Submit for review', `/api/seo/image-assets/${record.assetId}/submit`, 'POST', {})
  const reject = () =>
    run('Reject', `/api/seo/image-assets/${record.assetId}/reject`, 'POST', {
      note: note || undefined,
    })
  const approve = () =>
    run('Approve', `/api/seo/image-assets/${record.assetId}/approve`, 'POST', {
      expectedContentSha256: record.contentSha256,
      note: note || undefined,
    })

  const compliant = problems !== null && problems.length === 0
  const canApprove = !busy && !dirty && record.status !== 'approved' && compliant

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <p style={{ marginTop: 0 }}>
        <Link to="/seo/images">← All image assets</Link>
      </p>
      <h1 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        Image asset <Pill tone={statusTone(record.status)}>{record.status}</Pill>
        {dirty && <Pill tone="warning">unsaved changes</Pill>}
      </h1>
      <p className="subtle-copy" style={{ marginTop: 0 }}>
        Helios records the image's content hash + metadata + approval. The bytes themselves are
        hosted by the renderer / object store and addressed by the hash. Approved assets can be
        referenced by a post's hero/og image.
      </p>

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
        Content hash (sha256 of the image bytes — 64 hex chars)
        <input
          type="text"
          value={draft.assetSha256}
          onChange={(e) => patch({ assetSha256: e.target.value })}
          disabled={busy}
          placeholder="e.g. a1b2c3… (64 lowercase hex chars)"
          style={{ width: '100%', fontFamily: 'monospace' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          Role
          <select
            value={draft.role}
            onChange={(e) => patch({ role: e.target.value as SeoImageRole })}
            disabled={busy}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          Media type
          <input
            type="text"
            value={draft.mediaType}
            onChange={(e) => patch({ mediaType: e.target.value })}
            disabled={busy}
            placeholder="image/webp"
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, width: 110 }}>
          Width (px)
          <input
            type="number"
            min={1}
            value={draft.widthText}
            onChange={(e) => patch({ widthText: e.target.value })}
            disabled={busy}
          />
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, width: 110 }}>
          Height (px)
          <input
            type="number"
            min={1}
            value={draft.heightText}
            onChange={(e) => patch({ heightText: e.target.value })}
            disabled={busy}
          />
        </label>
      </div>

      <label style={{ display: 'block', marginTop: 8 }}>
        Alt text (shown on BOTH hosts — keep sanitized-safe)
        <textarea
          value={draft.altText}
          onChange={(e) => patch({ altText: e.target.value })}
          disabled={busy}
          rows={2}
          style={{ width: '100%' }}
        />
      </label>

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
          Save your changes before approving — approval binds to the exact saved metadata.
        </p>
      )}

      {/* Provenance / debug — collapsed by default per helios page rules. */}
      <details style={{ marginTop: 16 }}>
        <summary>Provenance &amp; debug</summary>
        <dl>
          <dt>Asset id</dt>
          <dd>
            <code>{record.assetId}</code>
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

function approveTitle(dirty: boolean, compliant: boolean, status: SeoImageAssetStatus): string {
  if (status === 'approved') {
    return 'Already approved.'
  }
  if (dirty) {
    return 'Save your changes first.'
  }
  if (!compliant) {
    return 'Resolve the compliance problems first.'
  }
  return 'Approve this exact image asset (IRONCLAD human gate).'
}
