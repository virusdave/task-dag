import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  WEEKDAY_MASK_ALL,
  type ConfigBackgroundTaskDetailResponse,
  type ConfigWorkerScheduleWindow,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import { describeWindow } from './schedulingFormat.js'

export async function configLitalertsScheduleLoader(): Promise<ConfigBackgroundTaskDetailResponse> {
  return loadJson(
    '/api/config/workers/schedules/workers.scheduling.litalerts',
    ConfigBackgroundTaskDetailResponseSchema,
  )
}

interface DraftWindow {
  weekdayMask: number
  windowStartHHMM: string
  windowEndHHMM: string
  intervalMinutes: number
  paused: boolean
  notes: string
  id: number | null
}

function windowToDraft(window: ConfigWorkerScheduleWindow): DraftWindow {
  return {
    weekdayMask: window.weekdayMask,
    windowStartHHMM: minuteOfDayToHHMM(window.windowStartMinute),
    windowEndHHMM: minuteOfDayToHHMM(window.windowEndMinute),
    intervalMinutes: window.intervalMinutes,
    paused: window.paused,
    notes: window.notes ?? '',
    id: window.id ?? null,
  }
}

function minuteOfDayToHHMM(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function hhmmToMinuteOfDay(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) {
    throw new Error(`Invalid time "${value}". Use HH:MM (24h).`)
  }
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 24 || minutes < 0 || minutes >= 60) {
    throw new Error(`Time "${value}" out of range. Use HH:MM (24h).`)
  }
  return hours * 60 + minutes
}

export function ConfigLitalertsSchedulePage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as ConfigBackgroundTaskDetailResponse
  const revalidator = useRevalidator()
  const [drafts, setDrafts] = useState<DraftWindow[]>(data.schedule.windows.map(windowToDraft))
  const [saving, setSaving] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function updateDraft(index: number, patch: Partial<DraftWindow>) {
    setDrafts((current) => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  function addDraft() {
    setDrafts((current) => [
      ...current,
      {
        weekdayMask: WEEKDAY_MASK_ALL,
        windowStartHHMM: '00:00',
        windowEndHHMM: '24:00',
        intervalMinutes: 5,
        paused: false,
        notes: '',
        id: null,
      },
    ])
  }

  function removeDraft(index: number) {
    setDrafts((current) => current.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setErrorMessage(null)
    setNotice(null)
    setSaving(true)
    try {
      const windows = drafts.map((draft) => ({
        weekdayMask: draft.weekdayMask,
        windowStartMinute: hhmmToMinuteOfDay(draft.windowStartHHMM),
        windowEndMinute: hhmmToMinuteOfDay(draft.windowEndHHMM),
        intervalMinutes: Math.max(1, Math.min(1440, Math.floor(draft.intervalMinutes))),
        paused: draft.paused,
        notes: draft.notes ? draft.notes : null,
        id: draft.id ?? undefined,
      }))
      const response = await mutateJson(
        '/api/config/workers/schedules/workers.scheduling.litalerts',
        ConfigBackgroundTaskDetailResponseSchema,
        {
          method: 'PUT',
          body: JSON.stringify({ taskKey: 'workers.scheduling.litalerts', windows }),
        },
      )
      setDrafts(response.schedule.windows.map(windowToDraft))
      setNotice('Schedule saved.')
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save schedule.')
    } finally {
      setSaving(false)
    }
  }

  async function handleRunNow() {
    setErrorMessage(null)
    setNotice(null)
    setRunningNow(true)
    try {
      const response = await mutateJson(
        '/api/config/workers/schedules/workers.scheduling.litalerts/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.litalerts' }),
        },
      )
      setNotice(`Queued Lit Alerts refresh; latest job #${response.jobId}.`)
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue Lit Alerts refresh.')
    } finally {
      setRunningNow(false)
    }
  }

  const litalerts = data.litalerts

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers / Scheduling</p>
          <h2>Litalerts</h2>
          <p className="subtle-copy">
            Drains the pending Lit Alerts refresh queue. The Stock worker enqueues a row whenever a variant transitions out-of-stock to in-stock at a site; this scheduler picks up those rows in modest batches and captures competitor listings as observations.
          </p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      {notice ? <p className="success-copy">{notice}</p> : null}
      {errorMessage ? <p className="error-copy">{errorMessage}</p> : null}

      <article className="mini-card">
        <header>
          <strong>Schedule windows</strong>
          <span className="subtle-copy">
            Last enqueued: {data.schedule.lastEnqueuedAt ? new Date(data.schedule.lastEnqueuedAt).toLocaleString() : 'never'}
          </span>
        </header>
        <table className="dense-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>End</th>
              <th>Every (min)</th>
              <th>Days</th>
              <th>Paused</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft, index) => (
              <tr key={draft.id ?? `new-${index}`}>
                <td>
                  <input
                    type="time"
                    value={draft.windowStartHHMM}
                    onChange={(event) => updateDraft(index, { windowStartHHMM: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={draft.windowEndHHMM}
                    onChange={(event) => updateDraft(index, { windowEndHHMM: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={draft.intervalMinutes}
                    onChange={(event) => updateDraft(index, { intervalMinutes: Number(event.currentTarget.value) })}
                    style={{ width: '5rem' }}
                  />
                </td>
                <td>
                  <WeekdayMaskEditor
                    mask={draft.weekdayMask}
                    onChange={(mask) => updateDraft(index, { weekdayMask: mask })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={draft.paused}
                    onChange={(event) => updateDraft(index, { paused: event.currentTarget.checked })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={draft.notes}
                    onChange={(event) => updateDraft(index, { notes: event.currentTarget.value })}
                    style={{ width: '18rem' }}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => removeDraft(index)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="inline-row wrap-row" style={{ marginTop: '0.5rem' }}>
          <button type="button" onClick={addDraft} disabled={saving}>
            Add window
          </button>
          <button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save schedule'}
          </button>
          <button type="button" onClick={handleRunNow} disabled={runningNow}>
            {runningNow ? 'Queueing...' : 'Drain pending now'}
          </button>
        </div>
      </article>

      <article className="mini-card">
        <header>
          <strong>Live preview</strong>
        </header>
        <ul className="subtle-copy">
          {drafts.map((draft, index) => (
            <li key={`preview-${index}`}>
              {describeWindow({
                id: draft.id ?? undefined,
                weekdayMask: draft.weekdayMask,
                windowStartMinute: safeHhmm(draft.windowStartHHMM),
                windowEndMinute: safeHhmm(draft.windowEndHHMM),
                intervalMinutes: draft.intervalMinutes,
                paused: draft.paused,
                notes: draft.notes ? draft.notes : null,
              })}
            </li>
          ))}
        </ul>
      </article>

      <article className="mini-card">
        <header>
          <strong>Pending refresh queue</strong>
          <Pill tone={litalerts && litalerts.pendingQueueDepth > 0 ? 'warning' : 'muted'}>
            {litalerts ? `${litalerts.pendingQueueDepth} pending` : '0 pending'}
          </Pill>
        </header>
        {!litalerts || litalerts.pendingQueueSample.length === 0 ? (
          <p className="subtle-copy">No pending refresh rows right now.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Queue row</th>
                <th>Product</th>
                <th>Site</th>
                <th>Reason</th>
                <th>Source snapshot</th>
                <th>Enqueued</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {litalerts.pendingQueueSample.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.productId}</td>
                  <td>{row.siteDealerId ?? '-'}</td>
                  <td>{row.reason}</td>
                  <td>{row.sourceSnapshotId ?? '-'}</td>
                  <td>{new Date(row.enqueuedAt).toLocaleString()}</td>
                  <td>{row.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      <article className="mini-card">
        <header>
          <strong>Recent competitor observations</strong>
        </header>
        {!litalerts || litalerts.recentObservations.length === 0 ? (
          <p className="subtle-copy">No observations recorded yet.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Captured</th>
                <th>Product</th>
                <th>Brand</th>
                <th>Group</th>
                <th>Status</th>
                <th>Listings</th>
                <th>Eligible</th>
                <th>Near</th>
                <th>Mid</th>
                <th>Far</th>
                <th>Search term</th>
                <th>Availability</th>
                <th>Job</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {litalerts.recentObservations.map((observation) => (
                <tr key={observation.id}>
                  <td>{new Date(observation.capturedAt).toLocaleString()}</td>
                  <td>{observation.productId}</td>
                  <td>{observation.brandName ?? '-'}</td>
                  <td>{observation.groupName ?? '-'}</td>
                  <td>
                    <Pill tone={statusTone(observation.status)}>{observation.status}</Pill>
                  </td>
                  <td>{observation.listingCount}</td>
                  <td>{observation.pricingEligibleListingCount}</td>
                  <td>{observation.nearListingCount}</td>
                  <td>{observation.midListingCount}</td>
                  <td>{observation.farListingCount}</td>
                  <td>{observation.searchTermLabel ?? '-'}</td>
                  <td>{observation.availability ?? '-'}</td>
                  <td>{observation.jobId ?? '-'}</td>
                  <td>{observation.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
    </section>
  )
}

function safeHhmm(value: string): number {
  try {
    return hhmmToMinuteOfDay(value)
  } catch {
    return 0
  }
}

function statusTone(status: 'succeeded' | 'failed'): 'success' | 'danger' {
  return status === 'succeeded' ? 'success' : 'danger'
}

function WeekdayMaskEditor({ mask, onChange }: { mask: number; onChange: (mask: number) => void }) {
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  return (
    <div className="inline-row" role="group" aria-label="Weekday selection">
      {labels.map((label, bit) => {
        const bitFlag = 1 << bit
        const checked = (mask & bitFlag) !== 0
        return (
          <label key={`${label}-${bit}`} title={`Bit ${bit}`} style={{ marginRight: '0.25rem' }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => {
                const next = event.currentTarget.checked ? mask | bitFlag : mask & ~bitFlag
                onChange(next)
              }}
            />
            {label}
          </label>
        )
      })}
    </div>
  )
}
