import { Link } from 'react-router-dom'

import {
  buildHeliosModulePath,
  getHeliosModuleDefinition,
  type HeliosModuleCode,
} from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'

export function ModuleLandingPage({ moduleCode }: { moduleCode: HeliosModuleCode }) {
  const moduleDefinition = getHeliosModuleDefinition(moduleCode)

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{moduleDefinition.label}</p>
          <h2>{moduleDefinition.label} is not migrated yet</h2>
          <p className="subtle-copy">{moduleDefinition.summary}</p>
        </div>
        <Pill tone="warning">planned</Pill>
      </div>

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Migration approach</strong>
            <Pill tone="muted">incremental</Pill>
          </header>
          <p className="subtle-copy">
            Keep the current script-level workflow in place until this module is wrapped with Helios routes, typed worker jobs,
            dependency gating, audit events, and operator-visible outputs.
          </p>
        </article>

        <article className="mini-card">
          <header>
            <strong>Shared surfaces already ready</strong>
            <Pill tone="success">live</Pill>
          </header>
          <p className="subtle-copy">
            When this module lands, it should plug into the existing global jobs page, audit history, auth/session model, and dependency health strip.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to="/jobs">Open jobs</Link>
            <Link to="/history">Open history</Link>
            <Link to={buildHeliosModulePath('catalog')}>See the first live module</Link>
          </div>
        </article>
      </div>
    </section>
  )
}
