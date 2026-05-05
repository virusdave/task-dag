import { NavLink } from 'react-router-dom'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'

export function PricingNav() {
  return (
    <nav className="module-subnav">
      <NavLink to={buildHeliosModulePath('pricing', 'generate')}>New run</NavLink>
      <NavLink to={buildHeliosModulePath('pricing', 'runs')}>Run history</NavLink>
      <NavLink end to={buildHeliosModulePath('pricing', 'review')}>
        Review queue
      </NavLink>
    </nav>
  )
}
