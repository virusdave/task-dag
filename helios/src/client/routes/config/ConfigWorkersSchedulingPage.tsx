import { Link, useLoaderData } from 'react-router-dom'

import {
  ConfigBackgroundTasksListResponseSchema,
  buildHeliosModulePath,
  type ConfigBackgroundTasksListResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'
import { describeWindow } from './schedulingFormat.js'

export async function configWorkersSchedulingLoader(): Promise<ConfigBackgroundTasksListResponse> {
  return loadJson('/api/config/workers/schedules', ConfigBackgroundTasksListResponseSchema)
}

export function ConfigWorkersSchedulingPage() {
  useRegisterConfigSidebarSubtree()
  const data = useLoaderData() as ConfigBackgroundTasksListResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers</p>
          <h2>Scheduling</h2>
          <p className="subtle-copy">
            Each row schedules a Helios background worker. Click a task to edit its windows or trigger a one-off run.
          </p>
        </div>
      </div>

      <div className="review-grid">
        {data.schedules.map((schedule) => {
          const slug = schedule.taskKey.split('.').pop() ?? schedule.taskKey
          const detailPath = buildHeliosModulePath('config', `workers/scheduling/${slug}`)
          return (
            <article className="mini-card" key={schedule.taskKey}>
              <header>
                <strong>{schedule.taskLabel}</strong>
                <Pill tone={schedule.implemented ? 'success' : 'warning'}>
                  {schedule.implemented ? 'live' : 'todo'}
                </Pill>
              </header>
              <p className="subtle-copy">{schedule.taskSummary}</p>
              {schedule.windows.length > 0 ? (
                <ul className="subtle-copy">
                  {schedule.windows.map((window, index) => (
                    <li key={window.id ?? index}>{describeWindow(window)}</li>
                  ))}
                </ul>
              ) : (
                <p className="subtle-copy">No windows configured.</p>
              )}
              <p className="subtle-copy">
                Last enqueued: {schedule.lastEnqueuedAt ? new Date(schedule.lastEnqueuedAt).toLocaleString() : 'never'}
              </p>
              <div className="inline-row wrap-row module-card-links">
                <Link to={detailPath}>Open {schedule.taskLabel}</Link>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
