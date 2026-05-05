import { Link } from 'react-router-dom'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterConfigSidebarSubtree } from './configSidebarSubtree.js'

export function ConfigWorkersPage() {
  useRegisterConfigSidebarSubtree()

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Config</p>
          <h2>Workers</h2>
          <p className="subtle-copy">
            Helios background-worker configuration. The first surface here is the Scheduling page, which lists every recurring worker schedule.
          </p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Scheduling</strong>
            <Pill tone="success">live</Pill>
          </header>
          <p className="subtle-copy">
            Periodic schedules that drive Helios cache refreshes (catalog, Lit Alerts competitor data, and per-site stock).
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('config', 'workers/scheduling')}>Open Scheduling</Link>
          </div>
        </article>
      </div>
    </section>
  )
}
