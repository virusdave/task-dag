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

export async function configCatalogScheduleLoader(): Promise<ConfigBackgroundTaskDetailResponse> {
  return loadJson(
    '/api/config/workers/schedules/workers.scheduling.catalog',
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

export function ConfigCatalogSchedulePage() {
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
        windowStartHHMM: '08:00',
        windowEndHHMM: '20:00',
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
        '/api/config/workers/schedules/workers.scheduling.catalog',
        ConfigBackgroundTaskDetailResponseSchema,
        {
          method: 'PUT',
          body: JSON.stringify({ taskKey: 'workers.scheduling.catalog', windows }),
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
        '/api/config/workers/schedules/workers.scheduling.catalog/run-now',
        ConfigBackgroundTaskRunNowResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify({ taskKey: 'workers.scheduling.catalog' }),
        },
      )
      setNotice(`Queued catalog refresh job #${response.jobId}.`)
      revalidator.revalidate()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue catalog refresh.')
    } finally {
      setRunningNow(false)
    }
  }

  const catalog = data.catalog

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers / Scheduling</p>
          <h2>Catalog</h2>
          <p className="subtle-copy">
            Periodic state-level catalog taxonomy snapshot. Captures products, groups, brands, categories, subcategories, strains, prevalences, sizes, and distributors so downstream Helios surfaces stay aligned with the live Sweed taxonomy.
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
            {runningNow ? 'Queueing...' : 'Run now'}
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
          <strong>Recent catalog snapshots</strong>
        </header>
        {!catalog || catalog.recentSnapshots.length === 0 ? (
          <p className="subtle-copy">No snapshots recorded yet.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Products</th>
                <th>Groups</th>
                <th>Brands</th>
                <th>Categories</th>
                <th>Subcategories</th>
                <th>Strains</th>
                <th>Prevalences</th>
                <th>Sizes</th>
                <th>Distributors</th>
                <th>Job</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {catalog.recentSnapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{new Date(snapshot.startedAt).toLocaleString()}</td>
                  <td>
                    <Pill tone={statusTone(snapshot.status)}>{snapshot.status}</Pill>
                  </td>
                  <td>{snapshot.trigger}</td>
                  <td>{snapshot.productCount ?? '-'}</td>
                  <td>{snapshot.groupCount ?? '-'}</td>
                  <td>{snapshot.brandCount ?? '-'}</td>
                  <td>{snapshot.categoryCount ?? '-'}</td>
                  <td>{snapshot.subcategoryCount ?? '-'}</td>
                  <td>{snapshot.strainCount ?? '-'}</td>
                  <td>{snapshot.prevalenceCount ?? '-'}</td>
                  <td>{snapshot.sizeCount ?? '-'}</td>
                  <td>{snapshot.distributorCount ?? '-'}</td>
                  <td>{snapshot.jobId ?? '-'}</td>
                  <td>{snapshot.error ?? ''}</td>
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

function statusTone(status: 'running' | 'succeeded' | 'failed'): 'success' | 'danger' | 'warning' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
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
