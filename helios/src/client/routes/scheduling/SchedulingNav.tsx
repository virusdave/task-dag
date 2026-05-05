import { NavLink } from 'react-router-dom'

import { buildHeliosModulePath } from '../../../shared/contracts/index.js'

export function SchedulingNav() {
  return (
    <nav className="module-subnav">
      <NavLink end to={buildHeliosModulePath('scheduling')}>
        Run history
      </NavLink>
      <NavLink to={buildHeliosModulePath('scheduling', 'new')}>New run</NavLink>
    </nav>
  )
}
