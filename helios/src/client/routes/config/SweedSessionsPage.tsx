// Operator surface for the Sweed session-token POOL.
//
// Workers (and one-off scripts) claim a row out of this pool for the
// duration of one job and release it when done; reCAPTCHA gating means
// no script can mint its own Sweed session, so the pool MUST be kept
// stocked by an operator pasting freshly-captured browser sessions here.
//
// Primary purpose of this page (kept at the top, no scrolling):
//   1. See at a glance whether the pool has a live, claimable token.
//   2. Paste a new session UUID (validated against Sweed before commit).
//   3. Retire dead rows.

import { useCallback, useEffect, useState } from 'react'
import { useLoaderData } from 'react-router-dom'
import { z } from 'zod'

import {
  PasteSweedSessionResponseSchema,
  SweedSessionsResponseSchema,
  type SweedSessionToken,
  type SweedSessionsResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill, type PillProps } from '../../components/Pill.js'

const AUTO_REFRESH_INTERVAL_MS = 30_000

const ExpireResponseSchema = z.object({ ok: z.literal(true) })

export async function sweedSessionsLoader() {
  return loadJson('/api/sweed/sessions', SweedSessionsResponseSchema)
}

function rowStatus(token: SweedSessionToken): { label: string; tone: PillProps['tone'] } {
  if (!token.isActive) {
    return { label: 'expired', tone: 'danger' }
  }
  if (token.isClaimed) {
    return { label: 'claimed (in use)', tone: 'warning' }
  }
  return { label: 'available', tone: 'success' }
}

function formatTimestamp(iso: string | null): string {
  if (iso === null) {
    return '—'
  }
  try {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  } catch {
    return iso
  }
}

export function SweedSessionsPage() {
  const initialData = useLoaderData() as SweedSessionsResponse
  const [data, setData] = useState<SweedSessionsResponse>(initialData)
  const [fetchedAt, setFetchedAt] = useState<Date>(new Date())
  const [error, setError] = useState<string | null>(null)

  const [tokenInput, setTokenInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [validate, setValidate] = useState(true)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [pasteResult, setPasteResult] = useState<string | null>(null)
  const [busyExpireId, setBusyExpireId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await loadJson('/api/sweed/sessions', SweedSessionsResponseSchema)
      setData(response)
      setFetchedAt(new Date())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load session pool.')
    }
  }, [])

  useEffect(() => {
    const handle = window.setInterval(() => void refresh(), AUTO_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [refresh])

  const handlePaste = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const token = tokenInput.trim()
      if (token.length < 8) {
        setError('Paste the full Sweed session UUID (the value of the `auth=` cookie).')
        return
      }
      setPasteBusy(true)
      setError(null)
      setPasteResult(null)
      try {
        const response = await mutateJson('/api/sweed/sessions', PasteSweedSessionResponseSchema, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token,
            label: labelInput.trim() || undefined,
            source: 'paste',
            validate,
          }),
        })
        setTokenInput('')
        setLabelInput('')
        setPasteResult(
          `Added token ${response.active.tokenPrefix}… to the pool` +
            (response.active.initialDealerId !== null
              ? ` (dealer ${response.active.initialDealerId}).`
              : '.'),
        )
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Failed to add session token.')
      } finally {
        setPasteBusy(false)
      }
    },
    [tokenInput, labelInput, validate, refresh],
  )

  const handleExpire = useCallback(
    async (token: SweedSessionToken) => {
      if (!window.confirm(`Retire token ${token.tokenPrefix}…? Workers will stop using it.`)) {
        return
      }
      setBusyExpireId(token.id)
      setError(null)
      try {
        await mutateJson(`/api/sweed/sessions/${token.id}/expire`, ExpireResponseSchema, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'Manually retired from the sessions page.' }),
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Failed to retire token.')
      } finally {
        setBusyExpireId(null)
      }
    },
    [refresh],
  )

  const availableCount = data.items.filter((token) => token.isAvailable).length
  const claimedCount = data.items.filter((token) => token.isClaimed).length

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Sweed</p>
          <h2>Sweed session pool</h2>
          <p className="subtle-copy">
            Workers claim one token per job. Keep at least one <strong>available</strong> token staged
            here or every Sweed-backed job (catalog sync, reconcile, screens, pending purchases) will
            stay queued.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Pill tone={availableCount > 0 ? 'success' : 'danger'}>
            {`${availableCount} available`}
          </Pill>
          <Pill tone={claimedCount > 0 ? 'warning' : 'muted'}>{`${claimedCount} in use`}</Pill>
          <span className="subtle-copy">last fetch {fetchedAt.toLocaleTimeString()}</span>
        </div>
      </div>

      {availableCount === 0 ? (
        <div className="runtime-status-strip" style={{ marginTop: 12 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">pool empty</Pill>
            <span className="subtle-copy">
              No live token — Sweed-backed jobs are blocked. Paste a fresh session below.
            </span>
          </div>
        </div>
      ) : null}

      <form className="filter-row" onSubmit={handlePaste} style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <input
          value={tokenInput}
          onChange={(event) => setTokenInput(event.target.value)}
          placeholder="Paste auth=… session UUID"
          style={{ minWidth: 320, flex: '1 1 320px' }}
          autoComplete="off"
          spellCheck={false}
        />
        <input
          value={labelInput}
          onChange={(event) => setLabelInput(event.target.value)}
          placeholder="Label (optional)"
          maxLength={200}
        />
        <label className="inline-row" style={{ gap: 6 }}>
          <input type="checkbox" checked={validate} onChange={(event) => setValidate(event.target.checked)} />
          <span className="subtle-copy">validate before adding</span>
        </label>
        <button className="primary-button" type="submit" disabled={pasteBusy}>
          {pasteBusy ? 'Adding…' : 'Add to pool'}
        </button>
      </form>

      {pasteResult ? (
        <div className="runtime-status-strip" style={{ marginTop: 8 }}>
          <div className="runtime-status-item">
            <Pill tone="success">added</Pill>
            <span className="subtle-copy">{pasteResult}</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="runtime-status-strip" style={{ marginTop: 8 }}>
          <div className="runtime-status-item">
            <Pill tone="danger">error</Pill>
            <span className="subtle-copy" style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
          </div>
        </div>
      ) : null}

      <div className="stacked-list" style={{ marginTop: 12 }}>
        {data.items.length === 0 ? (
          <article className="history-card">
            <p className="subtle-copy">
              The pool is empty. Paste a session UUID above to stock it. If you just applied
              migrations 014/015 this is expected on a fresh database.
            </p>
          </article>
        ) : (
          data.items.map((token) => {
            const status = rowStatus(token)
            return (
              <article className="history-card" key={token.id}>
                <div className="history-card-topline">
                  <div>
                    <strong>{token.tokenPrefix}…</strong>
                    <p className="subtle-copy">
                      added {formatTimestamp(token.createdAt)}
                      {token.createdByLabel ? <> · by {token.createdByLabel}</> : null}
                      {token.label ? <> · {token.label}</> : null}
                      {' · '}source {token.source}
                    </p>
                  </div>
                  <div className="inline-row wrap-row">
                    <Pill tone={status.tone}>{status.label}</Pill>
                    {token.initialDealerId !== null ? (
                      <Pill tone="muted">{`dealer ${token.initialDealerId}`}</Pill>
                    ) : null}
                    {token.isActive ? (
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={busyExpireId === token.id}
                        onClick={() => void handleExpire(token)}
                      >
                        {busyExpireId === token.id ? 'Retiring…' : 'Retire'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {token.isClaimed ? (
                  <p className="subtle-copy" style={{ marginTop: 6 }}>
                    claimed by {token.claimedBy ?? '?'} · lease until {formatTimestamp(token.claimExpiresAt)}
                  </p>
                ) : null}
                {!token.isActive ? (
                  <p className="subtle-copy" style={{ marginTop: 6 }}>
                    expired {formatTimestamp(token.markedExpiredAt)}
                    {token.expiredReason ? <> · {token.expiredReason}</> : null}
                  </p>
                ) : null}
              </article>
            )
          })
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary className="subtle-copy">About this page / how to capture a session</summary>
        <div className="subtle-copy" style={{ marginTop: 8, lineHeight: 1.5 }}>
          <p>
            Log into Sweed in a browser, open DevTools → Application → Cookies, copy the value of the{' '}
            <code>auth</code> cookie, and paste it above. You can paste either the bare UUID or the
            whole <code>auth=…</code> string — the server strips the prefix.
          </p>
          <p>
            With <strong>validate before adding</strong> checked (default), the server issues a no-op{' '}
            <code>store.auth.initial.data.get</code> with the pasted token and rejects it if Sweed
            says it is expired, so you never stage a dead row. Tokens are stored masked; only the
            8-char prefix is ever shown after the initial add.
          </p>
          <p>
            Each worker job claims one available row for its duration and releases it on completion.
            A token that returns an auth error mid-job is retired automatically. See{' '}
            <code>docs/sweed/getting-a-token-for-one-offs.md</code>.
          </p>
        </div>
      </details>
    </section>
  )
}
