import type { PermissionSet, Role } from '../contracts/domain/auth.js'

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
