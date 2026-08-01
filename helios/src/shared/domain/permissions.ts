import type { PermissionSet, Role, SessionUser } from '../contracts/domain/auth.js'

/** Role identity is authoritative; capabilities are not proxies for roles. */
export function isAdminUser(
  user: Pick<SessionUser, 'role'> | null | undefined,
): boolean {
  return user?.role === 'admin'
}

export function getPermissionsForRole(role: Role | null): PermissionSet {
  switch (role) {
    case 'viewer':
      return {
        canApprove: false,
        canEditProposals: false,
        canForceReconcile: false,
        canManageUsers: false,
        canUndo: false,
      }
    case 'editor':
      return {
        canApprove: false,
        canEditProposals: true,
        canForceReconcile: false,
        canManageUsers: false,
        canUndo: false,
      }
    case 'approver':
      return {
        canApprove: true,
        canEditProposals: true,
        canForceReconcile: false,
        canManageUsers: false,
        canUndo: false,
      }
    case 'admin':
      return {
        canApprove: true,
        canEditProposals: true,
        canForceReconcile: true,
        canManageUsers: true,
        canUndo: true,
      }
    case null:
      return {
        canApprove: false,
        canEditProposals: false,
        canForceReconcile: false,
        canManageUsers: false,
        canUndo: false,
      }
  }
}
