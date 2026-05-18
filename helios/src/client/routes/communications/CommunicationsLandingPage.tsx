import { Link } from 'react-router-dom'

import { getHeliosModuleDefinition } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { COMMUNICATIONS_SIDEBAR_SUBTREE } from './communicationsSidebar.js'

const DEFAULT_PACKET_ID = 'asset-policy-limited-replacement-plan-2026-05-05_110134'

export function CommunicationsLandingPage() {
  const moduleDefinition = getHeliosModuleDefinition('communications')
  useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{`${moduleDefinition.label} \u203A Overview`}</p>
          <h2>{moduleDefinition.label}</h2>
          <p className="subtle-copy">{moduleDefinition.summary}</p>
        </div>
        <Pill tone="success">active</Pill>
      </div>

      <article className="detail-panel">
        <header className="page-header">
          <h3>Ads · Drive ingest</h3>
          <Pill tone="success">auto-watching</Pill>
        </header>
        <p className="subtle-copy">
          Helios polls the canonical Google Drive export folder every 30s and
          rebuilds the experiments visualizer + recovery bundle whenever the
          newest CSV changes. Use this page to see the current state and force
          an immediate pull.
        </p>
        <div className="inline-row wrap-row">
          <Link to="/communications/drive-ingest">Open Drive ingest status</Link>
        </div>
      </article>

      <article className="detail-panel">
        <header className="page-header">
          <h3>Ads · Cluster proposals</h3>
          <Pill tone="muted">weekly + on-demand</Pill>
        </header>
        <p className="subtle-copy">
          Strategic-cluster proposals + ad-side repair work, produced by the
          weekly <code>gads-cluster-sweep.service</code> on vps-nixos-3 (plus
          on-demand triggers). Each run drops a downloadable bundle ZIP with
          per-cluster Ads Editor CSVs (Lane A) and a Web-UI operator
          checklist with deep-links (Lane C). See the
          {' '}
          <a
            href="https://github.com/virusdave/top-level/blob/master/docs/epics/gemini-clusters/EPIC_PLAN.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            gemini-clusters epic
          </a>
          {' '}for the full plan.
        </p>
        <div className="inline-row wrap-row">
          <Link to="/communications/cluster-proposals">Open Cluster proposals</Link>
        </div>
      </article>

      <article className="detail-panel">
        <header className="page-header">
          <h3>Ads · Review · Assets · Policy-limited replacement</h3>
          <Pill tone="warning">human review required</Pill>
        </header>
        <p className="subtle-copy">
          Reviewer-facing surface for the static planning packet pair under
          <code> ads/google/policy/asset_policy_limited_replacement_plan_*.json</code>.
          Helios persists draft and submitted reviewer state and emits append-only audit events; live Google Ads
          mutates still run through a separate narrow resolver pass after submission.
        </p>
        <div className="inline-row wrap-row">
          <Link to={`/communications/policy-replacements/${DEFAULT_PACKET_ID}`}>
            Open the {DEFAULT_PACKET_ID} review
          </Link>
        </div>
      </article>
    </section>
  )
}
