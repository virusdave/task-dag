import { Link } from 'react-router-dom'

import {
  buildHeliosModulePath,
  type ConfigBackgroundTaskKey,
  getConfigBackgroundTaskDefinition,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export function ConfigSchedulingTodoPage({ taskKey }: { taskKey: ConfigBackgroundTaskKey }) {
  useRegisterConfigSidebarSubtree()
  const definition = getConfigBackgroundTaskDefinition(taskKey)

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config / Workers / Scheduling</p>
          <h2>{definition.label}</h2>
          <p className="subtle-copy">{definition.summary}</p>
        </div>
        <Pill tone="warning">todo</Pill>
      </div>

      <article className="mini-card">
        <header>
          <strong>Implementation pending</strong>
          <Pill tone="muted">placeholder</Pill>
        </header>
        <p className="subtle-copy">
          The {definition.label} background-worker schedule lives here once the worker job and snapshot tables are implemented. The schedule slot is reserved so the next agent has an obvious home for the work.
        </p>
        <p className="subtle-copy">
          See the active stock-refresh schedule for the canonical operator UX shape:
        </p>
        <div className="inline-row wrap-row module-card-links">
          <Link to={buildHeliosModulePath('config', 'workers/scheduling/stock')}>Open Stock schedule</Link>
          <Link to={buildHeliosModulePath('config', 'workers/scheduling')}>Back to Scheduling</Link>
        </div>
      </article>
    </section>
  )
}
