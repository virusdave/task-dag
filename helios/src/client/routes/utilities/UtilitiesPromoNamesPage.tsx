// Helios → Utilities → Promo Names
//
// Set the `shortName` on a Sweed promo action without the Sweed UI's
// length / character constraints. (Sweed's discounts form caps the
// input around 16-20 chars; the underlying RPC accepts more, as
// proven by long shipped names like "ConcentratesHappyHour25%".)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router-dom'

import {
  PromoNamesActionResponseSchema,
  PromoNamesDealerListResponseSchema,
  type PromoNamesAction,
  type PromoNamesDealer,
  type PromoNamesDealerListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { UTILITIES_SIDEBAR_SUBTREE } from './utilitiesSidebar.js'

export async function utilitiesPromoNamesLoader(): Promise<PromoNamesDealerListResponse> {
  return loadJson('/api/utilities/promo-names/dealers', PromoNamesDealerListResponseSchema)
}

export function UtilitiesPromoNamesPage() {
  useRegisterSidebarSubtree('utilities', UTILITIES_SIDEBAR_SUBTREE)

  const initial = useLoaderData() as PromoNamesDealerListResponse
  const dealers = initial.dealers

  const [dealerId, setDealerId] = useState<number | ''>(() => dealers[0]?.id ?? '')
  const [actionIdInput, setActionIdInput] = useState('')
  const [loadedAction, setLoadedAction] = useState<PromoNamesAction | null>(null)
  const [shortNameDraft, setShortNameDraft] = useState('')
  const [busy, setBusy] = useState<'lookup' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const dealerById = useMemo(() => {
    const m = new Map<number, PromoNamesDealer>()
    for (const d of dealers) m.set(d.id, d)
    return m
  }, [dealers])

  useEffect(() => {
    if (loadedAction !== null) {
      setShortNameDraft(loadedAction.shortName ?? '')
    }
  }, [loadedAction])

  const canLookup = dealerId !== '' && /^\d+$/.test(actionIdInput.trim()) && busy === null
  const draftDiffers =
    loadedAction !== null && shortNameDraft.trim().length > 0 && shortNameDraft !== (loadedAction.shortName ?? '')

  const handleLookup = useCallback(async () => {
    if (dealerId === '') return
    const trimmed = actionIdInput.trim()
    if (!/^\d+$/.test(trimmed)) {
      setError('Action id must be a positive integer.')
      return
    }
    setBusy('lookup')
    setError(null)
    setSuccess(null)
    setLoadedAction(null)
    try {
      const response = await loadJson(
        `/api/utilities/promo-names/actions/${dealerId}/${trimmed}`,
        PromoNamesActionResponseSchema,
      )
      setLoadedAction(response.action)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lookup failed.')
    } finally {
      setBusy(null)
    }
  }, [dealerId, actionIdInput])

  const handleApply = useCallback(async () => {
    if (!loadedAction) return
    const trimmed = shortNameDraft
    if (trimmed.length === 0) {
      setError('Short name cannot be empty.')
      return
    }
    setBusy('apply')
    setError(null)
    setSuccess(null)
    try {
      const response = await mutateJson(
        `/api/utilities/promo-names/actions/${loadedAction.dealerId}/${loadedAction.id}`,
        PromoNamesActionResponseSchema,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shortName: trimmed }),
        },
      )
      setLoadedAction(response.action)
      setSuccess(`Updated. Short name is now ${JSON.stringify(response.action.shortName)}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Edit failed.')
    } finally {
      setBusy(null)
    }
  }, [loadedAction, shortNameDraft])

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Utilities &rsaquo; Promo Names</p>
          <h2>Rename a promo action&rsquo;s short name (bypass Sweed UI limit)</h2>
        </div>
      </div>

      <article className="detail-panel" style={{ maxWidth: '46rem' }}>
        <div className="inline-row wrap-row" style={{ gap: '0.6rem', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span className="subtle-copy">Dealer</span>
            <select
              value={dealerId}
              onChange={(e) => setDealerId(e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))}
              disabled={busy !== null}
            >
              {dealers.length === 0 ? <option value="">(no dealers accessible)</option> : null}
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id} — {d.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span className="subtle-copy">Action id</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={actionIdInput}
              onChange={(e) => setActionIdInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canLookup) {
                  e.preventDefault()
                  void handleLookup()
                }
              }}
              placeholder="e.g. 46333"
              size={12}
              disabled={busy !== null}
            />
          </label>
          <button type="button" onClick={() => void handleLookup()} disabled={!canLookup}>
            {busy === 'lookup' ? 'Looking up…' : 'Look up'}
          </button>
        </div>

        {error ? (
          <p style={{ marginTop: '0.75rem' }}>
            <Pill tone="danger">{error}</Pill>
          </p>
        ) : null}
        {success ? (
          <p style={{ marginTop: '0.75rem' }}>
            <Pill tone="success">{success}</Pill>
          </p>
        ) : null}

        {loadedAction ? (
          <div style={{ marginTop: '1rem' }}>
            <table className="detail-table" style={{ width: '100%' }}>
              <tbody>
                <tr>
                  <th>Action id</th>
                  <td>
                    <code>{loadedAction.id}</code>
                    {loadedAction.enabled ? null : (
                      <>
                        {' '}
                        <Pill tone="danger">disabled</Pill>
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Dealer</th>
                  <td>
                    {loadedAction.dealerId} — {dealerById.get(loadedAction.dealerId)?.name ?? '(unknown)'}
                  </td>
                </tr>
                <tr>
                  <th>Campaign</th>
                  <td>
                    {loadedAction.campaignName ?? '—'}{' '}
                    {loadedAction.campaignId ? <code>({loadedAction.campaignId})</code> : null}
                  </td>
                </tr>
                <tr>
                  <th>Name</th>
                  <td>{loadedAction.name}</td>
                </tr>
                <tr>
                  <th>Current short name</th>
                  <td>
                    <code>{loadedAction.shortName ?? '(null)'}</code>{' '}
                    <span className="subtle-copy">
                      ({(loadedAction.shortName ?? '').length} chars)
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span className="subtle-copy">
                  New short name ({shortNameDraft.length} chars — no client-side length limit)
                </span>
                <input
                  type="text"
                  value={shortNameDraft}
                  onChange={(e) => setShortNameDraft(e.currentTarget.value)}
                  disabled={busy !== null}
                  style={{ fontFamily: 'monospace' }}
                />
              </label>
              <div>
                <button
                  type="button"
                  onClick={() => void handleApply()}
                  disabled={!draftDiffers || busy !== null}
                >
                  {busy === 'apply' ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </article>

      <details style={{ marginTop: '1rem' }}>
        <summary>About this page</summary>
        <div className="subtle-copy" style={{ marginTop: '0.5rem' }}>
          <p>
            Sweed&rsquo;s Discounts editor at
            {' '}
            <code>/marketing/discounts/campaign/action/&lt;id&gt;</code> caps the
            &ldquo;short name&rdquo; input field somewhere around 16-20 chars and
            tends to forbid spaces. The underlying RPC
            (<code>store.promo.action.edit</code>) is more permissive — several
            shipped short names like <code>ConcentratesHappyHour25%</code> and
            <code> Herb T.C. 3.5g $26.50</code> exceed what the form will accept.
          </p>
          <p>
            This page wraps that RPC. Look up an action by id (the &nbsp;
            <code>...&#47;action/&lt;id&gt;</code> path segment from the Sweed URL),
            review the current name, and apply a new short name as long as
            Sweed&rsquo;s backend accepts it. The action is logged into the
            sweed-auth-events trail like every other Helios → Sweed RPC.
          </p>
        </div>
      </details>
    </section>
  )
}
