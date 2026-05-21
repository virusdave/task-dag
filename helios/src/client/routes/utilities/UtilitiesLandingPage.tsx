import { Link } from 'react-router-dom'

import { getHeliosModuleDefinition } from '../../../shared/contracts/index.js'
import { Pill } from '../../components/Pill.js'
import { useRegisterSidebarSubtree } from '../../components/SidebarNavContext.js'
import { UTILITIES_SIDEBAR_SUBTREE } from './utilitiesSidebar.js'

export function UtilitiesLandingPage() {
  const moduleDefinition = getHeliosModuleDefinition('utilities')
  useRegisterSidebarSubtree('utilities', UTILITIES_SIDEBAR_SUBTREE)

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

      <div className="review-grid">
        <article className="mini-card">
          <header>
            <strong>Staff</strong>
            <Pill tone="success">live</Pill>
          </header>
          <p className="subtle-copy">
            Editorial approve / reject for the public &quot;Meet The Team&quot; section on the
            freshlybaked.nyc about page. Pulls the state-level employee list
            from Sweed (<code>user.compliance.list</code>) and lets an operator
            opt each profile into the public site.
          </p>
          <div className="inline-row wrap-row module-card-links">
            <Link to="/utilities/staff">Open Staff editor</Link>
          </div>
        </article>
      </div>
    </section>
  )
}
