import { useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router-dom'

import { WORKER_CAPACITY_CONFIG_VERSION, WorkerCapacityConfigSchema, WorkerCapacityResponseSchema, type WorkerCapacityResponse } from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime } from '../../app/nyTime.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export async function configWorkerCapacityLoader(): Promise<WorkerCapacityResponse> {
  return loadJson('/api/config/workers/capacity', WorkerCapacityResponseSchema)
}

export function ConfigWorkerCapacityPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as WorkerCapacityResponse
  const revalidator = useRevalidator()
  const [draft, setDraft] = useState(data.config)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const total = draft.generalSlots + draft.liveRequestedReservedSlots + draft.urgentReservedSlots
  const parsedDraft = WorkerCapacityConfigSchema.safeParse(draft)
  const unchanged = JSON.stringify(draft) === JSON.stringify(data.config)

  const fields = [
    ['generalSlots', 'General', 'Available to all work.'],
    ['liveRequestedReservedSlots', 'Live requested reserve', 'Live and urgent work can use these slots.'],
    ['urgentReservedSlots', 'Urgent reserve', 'Only urgent work can use these slots.'],
  ] as const

  async function save() {
    setBusy(true); setMessage(null)
    try {
      await mutateJson('/api/config/workers/capacity', WorkerCapacityResponseSchema, {
        method: 'PUT', body: JSON.stringify({ ...draft, version: WORKER_CAPACITY_CONFIG_VERSION }),
      })
      setMessage('Capacity saved.')
      revalidator.revalidate()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Save failed.')
    } finally { setBusy(false) }
  }

  return <section style={{ maxWidth: 680 }}>
    <div className="page-header"><div><p className="eyebrow">Workers</p><h2>Capacity</h2></div></div>
    <article className="mini-card">
      {fields.map(([key, label, help]) => <label key={key} style={{ display: 'block', marginBottom: 16 }}>
        <strong>{label}</strong><span className="subtle-copy" style={{ display: 'block' }}>{help}</span>
        <input style={{ minHeight: 44, width: '100%', maxWidth: 180 }} type="number" min={0} max={32} step={1} value={draft[key]}
          onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />
      </label>)}
      <p><strong>Total: {total} slots</strong> <span className="subtle-copy">(1 to 32)</span></p>
      {!parsedDraft.success && <p className="form-error" role="alert">{parsedDraft.error.issues[0]?.message}</p>}
      <button style={{ minHeight: 44 }} disabled={busy || !parsedDraft.success || unchanged} onClick={() => void save()}>{busy ? 'Saving…' : 'Save capacity'}</button>
      {message && <p role="status">{message}</p>}
    </article>
    <p className="subtle-copy">Updated by {data.updatedBy} at {nyLongDateTime(Date.parse(data.updatedAt))}. Higher-priority work may borrow lower-priority capacity. Lower-priority work cannot use reserved slots.</p>
  </section>
}
