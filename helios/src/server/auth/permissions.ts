import type { Role } from '../../shared/contracts/domain/auth.js'

const roleOrder: Role[] = ['viewer', 'editor', 'approver', 'admin']

export function hasAtLeastRole(actualRole: Role, minimumRole: Role): boolean {
  return roleOrder.indexOf(actualRole) >= roleOrder.indexOf(minimumRole)
}
