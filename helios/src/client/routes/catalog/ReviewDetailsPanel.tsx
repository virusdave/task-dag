import { useCallback, useEffect, useState } from 'react'

import {
  AnnotationsCreateResponseSchema,
  AnnotationsListResponseSchema,
  CommentsCreateResponseSchema,
  CommentsListResponseSchema,
  type AnnotationKind,
  type AnnotationRecord,
  type CommentRecord,
  type HeliosModuleCode,
  type ScopeKind,
  type ScopeRef,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { z } from 'zod'

const RerunResponseSchema = z.object({
  jobId: z.number().int().positive(),
  requestId: z.string(),
})
const FailResponseSchema = z.object({
  auditEventId: z.number().int().positive(),
  requestId: z.string(),
})

interface ReviewDetailsPanelProps {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeRef: ScopeRef
  /** Optional brand context to also load brand-level MSO annotation + comments. */
  brandScopeRef?: ScopeRef | null
}

function buildCommentsListUrl(module: HeliosModuleCode, scopeKind: ScopeKind, scopeRef: ScopeRef): string {
  const params = new URLSearchParams({
    module,
    scopeKind,
    scopeId: String(scopeRef.id),
  })
  if (scopeRef.brandId !== undefined) {
    params.set('brandId', String(scopeRef.brandId))
  }
  if (scopeRef.itemKey !== undefined) {
    params.set('itemKey', scopeRef.itemKey)
  }
  return `/api/comments?${params.toString()}`
}

function buildAnnotationsListUrl(
  module: HeliosModuleCode,
  scopeKind: ScopeKind,
  scopeRef: ScopeRef,
  kind?: AnnotationKind,
): string {
  const params = new URLSearchParams({
    module,
    scopeKind,
    scopeId: String(scopeRef.id),
  })
  if (kind) {
    params.set('kind', kind)
  }
  if (scopeRef.brandId !== undefined) {
    params.set('brandId', String(scopeRef.brandId))
  }
  if (scopeRef.itemKey !== undefined) {
    params.set('itemKey', scopeRef.itemKey)
  }
  return `/api/annotations?${params.toString()}`
}

interface CommentsThreadProps {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeRef: ScopeRef
  title: string
}

function CommentsThread({ module, scopeKind, scopeRef, title }: CommentsThreadProps) {
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadJson(
        buildCommentsListUrl(module, scopeKind, scopeRef),
        CommentsListResponseSchema,
      )
      setComments(result.comments)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load comments.')
    } finally {
      setLoading(false)
    }
  }, [module, scopeKind, scopeRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSubmit = useCallback(async () => {
    if (!draft.trim()) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await mutateJson('/api/comments', CommentsCreateResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          module,
          scopeKind,
          scopeRef,
          body: draft.trim(),
        }),
      })
      setDraft('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment.')
    } finally {
      setSaving(false)
    }
  }, [draft, module, refresh, scopeKind, scopeRef])

  const handleDelete = useCallback(
    async (commentId: number) => {
      setSaving(true)
      setError(null)
      try {
        await mutateJson(`/api/comments/${commentId}`, CommentsCreateResponseSchema, {
          method: 'DELETE',
        })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to retract comment.')
      } finally {
        setSaving(false)
      }
    },
    [refresh],
  )

  return (
    <section className="mini-card">
      <header>
        <strong>{title}</strong>
      </header>
      {loading ? <p className="subtle-copy">Loading comments...</p> : null}
      {error ? <p className="subtle-copy">Error: {error}</p> : null}
      {comments.length === 0 && !loading ? <p className="subtle-copy">No comments yet.</p> : null}
      <ul className="comment-list">
        {comments.map((comment) => (
          <li key={comment.id}>
            <div className="comment-meta subtle-copy">
              <span>{comment.authorLabel ?? `User ${comment.authorUserId ?? 'unknown'}`}</span>
              <span>{comment.createdAt}</span>
              <button type="button" onClick={() => void handleDelete(comment.id)} disabled={saving}>
                Retract
              </button>
            </div>
            <div className="comment-body">{comment.body}</div>
          </li>
        ))}
      </ul>
      <div className="inline-row wrap-row">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a comment"
          rows={2}
        />
        <button type="button" onClick={() => void handleSubmit()} disabled={saving || !draft.trim()}>
          Add comment
        </button>
      </div>
    </section>
  )
}

interface AnnotationsThreadProps {
  module: HeliosModuleCode
  scopeKind: ScopeKind
  scopeRef: ScopeRef
  defaultKind: AnnotationKind
  title: string
}

function AnnotationsThread({ module, scopeKind, scopeRef, defaultKind, title }: AnnotationsThreadProps) {
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<AnnotationKind>(defaultKind)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadJson(
        buildAnnotationsListUrl(module, scopeKind, scopeRef),
        AnnotationsListResponseSchema,
      )
      setAnnotations(result.annotations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load annotations.')
    } finally {
      setLoading(false)
    }
  }, [module, scopeKind, scopeRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSubmit = useCallback(async () => {
    if (!draft.trim()) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await mutateJson('/api/annotations', AnnotationsCreateResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          module,
          scopeKind,
          scopeRef,
          kind,
          body: draft.trim(),
        }),
      })
      setDraft('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add annotation.')
    } finally {
      setSaving(false)
    }
  }, [draft, kind, module, refresh, scopeKind, scopeRef])

  const handleRetract = useCallback(
    async (annotationId: number) => {
      setSaving(true)
      setError(null)
      try {
        await mutateJson(`/api/annotations/${annotationId}`, AnnotationsCreateResponseSchema, {
          method: 'DELETE',
        })
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to retract annotation.')
      } finally {
        setSaving(false)
      }
    },
    [refresh],
  )

  return (
    <section className="mini-card">
      <header>
        <strong>{title}</strong>
      </header>
      {loading ? <p className="subtle-copy">Loading annotations...</p> : null}
      {error ? <p className="subtle-copy">Error: {error}</p> : null}
      {annotations.length === 0 && !loading ? <p className="subtle-copy">No annotations yet.</p> : null}
      <ul className="comment-list">
        {annotations.map((annotation) => (
          <li key={annotation.id}>
            <div className="comment-meta subtle-copy">
              <span>{annotation.kind.toUpperCase()}</span>
              <span>{annotation.authorLabel ?? `User ${annotation.authorUserId ?? 'unknown'}`}</span>
              <span>{annotation.createdAt}</span>
              <button type="button" onClick={() => void handleRetract(annotation.id)} disabled={saving}>
                Retract
              </button>
            </div>
            <div className="comment-body">{annotation.body}</div>
          </li>
        ))}
      </ul>
      <div className="inline-row wrap-row">
        <select value={kind} onChange={(event) => setKind(event.target.value as AnnotationKind)}>
          <option value="mso">MSO</option>
          <option value="note">Note</option>
          <option value="flag">Flag</option>
          <option value="curator">Curator</option>
        </select>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add an annotation"
          rows={2}
        />
        <button type="button" onClick={() => void handleSubmit()} disabled={saving || !draft.trim()}>
          Add annotation
        </button>
      </div>
    </section>
  )
}

export function ReviewDetailsPanel({ module, scopeKind, scopeRef, brandScopeRef }: ReviewDetailsPanelProps) {
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionInfo, setActionInfo] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const handleRerun = useCallback(async () => {
    setBusy(true)
    setActionError(null)
    setActionInfo(null)
    try {
      const result = await mutateJson('/api/catalog/review/rerun-row', RerunResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          scopeKind,
          scopeRef,
          reason: reason.trim() || undefined,
        }),
      })
      setActionInfo(`Queued rerun job ${result.jobId}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rerun failed.')
    } finally {
      setBusy(false)
    }
  }, [reason, scopeKind, scopeRef])

  const handleFail = useCallback(async () => {
    setBusy(true)
    setActionError(null)
    setActionInfo(null)
    try {
      const result = await mutateJson('/api/catalog/review/fail-row', FailResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          scopeKind,
          scopeRef,
          reason: reason.trim() || undefined,
        }),
      })
      setActionInfo(`Recorded fail decision as audit event ${result.auditEventId}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Fail action failed.')
    } finally {
      setBusy(false)
    }
  }, [reason, scopeKind, scopeRef])

  return (
    <div className="review-details-panel">
      <section className="mini-card">
        <header>
          <strong>Row identity</strong>
        </header>
        <div className="subtle-copy">
          Module: {module} | Scope: {scopeKind} | Id: {String(scopeRef.id)}
          {scopeRef.brandId !== undefined ? <> | Brand: {String(scopeRef.brandId)}</> : null}
          {scopeRef.itemKey !== undefined ? <> | Item: {scopeRef.itemKey}</> : null}
        </div>
        <div className="inline-row wrap-row">
          <input
            type="text"
            placeholder="Optional reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="button" onClick={() => void handleRerun()} disabled={busy}>
            Re-run row
          </button>
          <button type="button" onClick={() => void handleFail()} disabled={busy}>
            Fail row
          </button>
        </div>
        {actionInfo ? <p className="subtle-copy">{actionInfo}</p> : null}
        {actionError ? <p className="subtle-copy">Error: {actionError}</p> : null}
      </section>

      <CommentsThread module={module} scopeKind={scopeKind} scopeRef={scopeRef} title="Comments" />
      <AnnotationsThread
        module={module}
        scopeKind={scopeKind}
        scopeRef={scopeRef}
        defaultKind="note"
        title="Annotations"
      />

      {brandScopeRef ? (
        <>
          <CommentsThread
            module={module}
            scopeKind="catalog_brand"
            scopeRef={brandScopeRef}
            title="Brand context: comments"
          />
          <AnnotationsThread
            module={module}
            scopeKind="catalog_brand"
            scopeRef={brandScopeRef}
            defaultKind="mso"
            title="Brand context: MSO annotation"
          />
        </>
      ) : null}
    </div>
  )
}
