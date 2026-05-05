import { Link } from 'react-router-dom'

import {
  CONFIG_BACKGROUND_TASKS,
  buildHeliosModulePath,
  getHeliosModuleDefinition,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

const moduleDefinition = getHeliosModuleDefinition('config')

export function ConfigModulePage() {
  useRegisterConfigSidebarSubtree()

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{moduleDefinition.label}</p>
          <h2>Config</h2>
          <p className="subtle-copy">{moduleDefinition.summary}</p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Workers</strong>
            <Pill tone="success">live</Pill>
          </header>
          <p className="subtle-copy">
            Configure the recurring background workers that scan Sweed and refresh Helios cache snapshots.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('config', 'workers/scheduling')}>Open Workers / Scheduling</Link>
            {CONFIG_BACKGROUND_TASKS.map((task) => (
              <Link
                key={task.slug}
                to={buildHeliosModulePath('config', `workers/scheduling/${task.slug}`)}
              >
                {task.label}
                {task.implemented ? '' : ' (TODO)'}
              </Link>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}
