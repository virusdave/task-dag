import { Link } from 'react-router-dom'

import { getHeliosModuleDefinition } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'

const DEFAULT_PACKET_ID = 'asset-policy-limited-replacement-plan-2026-05-05_110134'

export function CommunicationsLandingPage() {
  const moduleDefinition = getHeliosModuleDefinition('communications')

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">{`${moduleDefinition.label} \u203A Review`}</p>
          <h2>{moduleDefinition.label}</h2>
          <p className="subtle-copy">{moduleDefinition.summary}</p>
        </div>
        <Pill tone="success">active</Pill>
      </div>

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
