import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { HeliosModuleCode } from '../../shared/contracts/index.js'
import type { TreeNavNode } from './TreeNav.js'

/**
 * Sidebar nav context. Route pages register a per-module subtree to be
 * spliced into the primary AppShell sidebar (e.g. PolicyReplacementReviewPage
 * registers the Ads → Review → Assets → <TYPE> packet leaves under the
 * `communications` module branch).
 */

interface SidebarNavContextValue {
  subtreesByModule: Partial<Record<HeliosModuleCode, TreeNavNode[]>>
  setSubtree: (module: HeliosModuleCode, nodes: TreeNavNode[] | null) => void
}

const SidebarNavContext = createContext<SidebarNavContextValue | null>(null)

export function SidebarNavProvider({ children }: { children: ReactNode }) {
  const [subtreesByModule, setSubtreesByModule] = useState<Partial<Record<HeliosModuleCode, TreeNavNode[]>>>(
    {},
  )
  const setSubtree = useCallback((module: HeliosModuleCode, nodes: TreeNavNode[] | null) => {
    setSubtreesByModule((prev) => {
      const next = { ...prev }
      if (nodes === null) {
        delete next[module]
      } else {
        next[module] = nodes
      }
      return next
    })
  }, [])
  const value = useMemo<SidebarNavContextValue>(
    () => ({ subtreesByModule, setSubtree }),
    [subtreesByModule, setSubtree],
  )
  return <SidebarNavContext.Provider value={value}>{children}</SidebarNavContext.Provider>
}

export function useSidebarNav(): SidebarNavContextValue {
  const value = useContext(SidebarNavContext)
  if (!value) {
    throw new Error('useSidebarNav must be used within SidebarNavProvider.')
  }
  return value
}

/**
 * Hook used by route pages to register their module-scoped subtree into the
 * primary sidebar. The subtree is unregistered automatically on unmount.
 */
export function useRegisterSidebarSubtree(module: HeliosModuleCode, nodes: TreeNavNode[]): void {
  const { setSubtree } = useSidebarNav()
  useEffect(() => {
    setSubtree(module, nodes)
    return () => {
      setSubtree(module, null)
    }
  }, [module, nodes, setSubtree])
}
