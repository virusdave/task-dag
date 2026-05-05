import { Link, useRouteLoaderData } from 'react-router-dom'

import { HELIOS_MODULES, buildHeliosModulePath, type SessionEnvelope } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'

export function DashboardPage() {
  const session = useRouteLoaderData('root') as SessionEnvelope

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Helios Dashboard</p>
          <h2>One internal surface for Freshly Baked operations</h2>
          <p className="subtle-copy">
            Catalog and Screens are now live Helios modules. The next consolidation steps keep adding workflows behind the
            same auth, jobs, audit, and dependency-health surfaces.
          </p>
        </div>
      </div>

      <div className="review-grid" style={{ marginBottom: '1rem' }}>
        <article className="mini-card">
          <header>
            <strong>Shared operations surfaces</strong>
            <Pill tone="muted">global</Pill>
          </header>
          <p className="subtle-copy">
            Helios keeps one queue and one audit timeline across modules so operators can trace work without switching apps.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to="/jobs">Open jobs</Link>
            <Link to="/history">Open audit history</Link>
            <Link to={buildHeliosModulePath('catalog', 'review')}>Open review queue</Link>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Runtime readiness</strong>
            <Pill tone={session.runtimeDependencies.some((dependency) => dependency.status !== 'configured') ? 'warning' : 'success'}>
              {`${session.runtimeDependencies.filter((dependency) => dependency.status === 'configured').length}/${session.runtimeDependencies.length} configured`}
            </Pill>
          </header>
          <div className="stacked-list compact-stack">
            {session.runtimeDependencies.map((dependency) => (
              <div className="mini-card-row" key={dependency.code}>
                <div>
                  <strong>{dependency.label}</strong>
                  <p className="subtle-copy">{dependency.summary}</p>
                </div>
                <Pill tone={dependency.status === 'configured' ? 'success' : dependency.status === 'optional_missing' ? 'warning' : 'danger'}>
                  {dependency.status === 'configured' ? 'configured' : dependency.status === 'optional_missing' ? 'optional' : 'missing'}
                </Pill>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="page-header">
        <div>
          <p className="eyebrow">Modules</p>
          <h2>Incremental migration, one module at a time</h2>
        </div>
      </div>

      <div className="review-grid">
        {HELIOS_MODULES.map((module) => (
          <article className="mini-card" key={module.code}>
            <header>
              <strong>{module.label}</strong>
              <Pill tone={module.rolloutStatus === 'active' ? 'success' : 'warning'}>
                {module.rolloutStatus === 'active' ? 'live' : 'planned'}
              </Pill>
            </header>
            <p className="subtle-copy">{module.summary}</p>
            <div className="inline-row wrap-row module-card-links">
              <Link to={buildHeliosModulePath(module.code)}>
                {module.rolloutStatus === 'active' ? 'Open module' : 'View module plan'}
              </Link>
              {module.code === 'catalog' ? <Link to={buildHeliosModulePath('catalog', 'browser')}>Catalog browser</Link> : null}
              {module.code === 'catalog' ? <Link to="/jobs?module=catalog">Catalog jobs</Link> : null}
              {module.code === 'screens' ? <Link to="/jobs?module=screens">Screens jobs</Link> : null}
              {module.code === 'screens' ? <Link to="/history?module=screens">Screens history</Link> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
