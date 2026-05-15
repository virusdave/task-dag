import { useState } from 'react'
import { Form, Link, useLoaderData, useRevalidator, useRouteLoaderData } from 'react-router-dom'

import {
  HELIOS_MODULES,
  HistoryEventsResponseSchema,
  MutationAcceptedResponseSchema,
  buildHeliosModulePath,
  type HistoryEventsResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { waitForJob } from '../../app/jobPolling.js'
import { Pill } from '../../components/Pill.js'

const moduleLabelByCode = new Map(HELIOS_MODULES.map((module) => [module.code, module.label]))

export async function historyLoader({ request }: { request: Request }) {
  const url = new URL(request.url)
  return loadJson(`/api/history/events${url.search}`, HistoryEventsResponseSchema)
}

export function HistoryPage() {
  const data = useLoaderData() as HistoryEventsResponse
  const session = useRouteLoaderData('root') as SessionEnvelope
  const revalidator = useRevalidator()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingUndoEventId, setPendingUndoEventId] = useState<number | null>(null)

  async function requestUndo(event: HistoryEventsResponse['items'][number]) {
    if (!window.confirm(`Queue undo for ${event.eventType}?`)) {
      return
    }

    setErrorMessage(null)
    setPendingUndoEventId(event.eventId)
    try {
      const response = await mutateJson(
        `/api/history/events/${event.eventId}/undo`,
        MutationAcceptedResponseSchema,
        {
          body: JSON.stringify({ reason: null }),
          method: 'POST',
        },
      )
      if (response.jobId) {
        await waitForJob(response.jobId)
      }
      await revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not queue the undo request.')
    } finally {
      setPendingUndoEventId((current) => (current === event.eventId ? null : current))
    }
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Append-Only History</p>
          <h2>Every operator and system action in one timeline</h2>
        </div>
        <Form className="filter-row" method="get">
          <select defaultValue={data.filters.module ?? ''} name="module">
            <option value="">All modules</option>
            {HELIOS_MODULES.map((module) => (
              <option key={module.code} value={module.code}>{module.label}</option>
            ))}
          </select>
          <input defaultValue={data.filters.eventType ?? ''} name="eventType" placeholder="Event type" />
          <button className="ghost-button" type="submit">
            Filter
          </button>
        </Form>
      </div>
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      <div className="stacked-list">
        {data.items.map((event) => (
          <article className="history-card" key={event.eventId}>
            <div className="history-card-topline">
              <div>
                <strong>{event.eventType}</strong>
                <p className="subtle-copy">{event.actorLabel} · {new Date(event.createdAt).toLocaleString()}</p>
              </div>
              <div className="inline-row wrap-row">
                <Pill tone="muted">{moduleLabelByCode.get(event.module) ?? event.module}</Pill>
                {event.module === 'catalog' && event.scope?.entityType === 'catalog_group' ? (
                  <Link to={buildHeliosModulePath('catalog', `groups/${event.scope.entityId}`)}>Group detail</Link>
                ) : null}
                {event.undo ? <Pill tone="warning">{`undo ${event.undo.status}`}</Pill> : null}
                {session.permissions.canUndo && event.undoAvailable ? (
                  <button
                    className="ghost-button"
                    disabled={pendingUndoEventId === event.eventId}
                    onClick={() => void requestUndo(event)}
                    type="button"
                  >
                    {pendingUndoEventId === event.eventId ? 'Undoing…' : 'Queue undo'}
                  </button>
                ) : null}
              </div>
            </div>
            <p>{event.summaryText}</p>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </article>
        ))}
      </div>
    </section>
  )
}
