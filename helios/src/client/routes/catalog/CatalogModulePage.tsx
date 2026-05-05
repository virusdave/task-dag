import { Link } from 'react-router-dom'

import { buildHeliosModulePath, getHeliosModuleDefinition } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterCatalogSidebarSubtree } from './catalogSidebarSubtree.js'

const catalogModule = getHeliosModuleDefinition('catalog')

export function CatalogModulePage() {
  useRegisterCatalogSidebarSubtree()
  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Catalog Module</p>
          <h2>Review, sync, and reconcile managed catalog fields</h2>
          <p className="subtle-copy">{catalogModule.summary}</p>
        </div>
        <Pill tone="success">live</Pill>
      </div>

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Approval queue</strong>
            <Pill tone="warning">operator</Pill>
          </header>
          <p className="subtle-copy">
            Review description and pricing line items, edit suggestions, capture notes, and trigger reconcile jobs from the same flow.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('catalog', 'review')}>Open review queue</Link>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Catalog browser</strong>
            <Pill tone="muted">browse</Pill>
          </header>
          <p className="subtle-copy">
            Browse mirrored groups, queue proposal batches, import review packets, and drill into per-group live snapshots and writes.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('catalog', 'browser')}>Open browser</Link>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>Pending purchases</strong>
            <Pill tone="warning">review</Pill>
          </header>
          <p className="subtle-copy">
            Review purchase-driven catalog candidates, capture operator overrides, and keep the pending queue inside Helios before any worker apply path exists.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('catalog', 'pending-purchases')}>Open pending purchases</Link>
          </div>
        </article>

        <article className="mini-card">
          <header>
            <strong>History and queue</strong>
            <Pill tone="muted">shared</Pill>
          </header>
          <p className="subtle-copy">
            Use the dedicated catalog history page for proposal batches, live writes, and pending-purchase runs, then fall back to the shared jobs or raw audit feed when you need lower-level detail.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to={buildHeliosModulePath('catalog', 'history')}>Catalog history</Link>
            <Link to="/jobs?module=catalog">Catalog jobs</Link>
            <Link to="/history?module=catalog">Raw audit feed</Link>
          </div>
        </article>
      </div>
    </section>
  )
}
