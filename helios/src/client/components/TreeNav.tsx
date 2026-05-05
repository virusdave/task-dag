import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'

/**
 * Helios canonical tree navigation control.
 *
 * Windows-Explorer-style: every branch label is itself a clickable
 * navigation/selection target; the square `+`/`-` box on the left only
 * toggles expand state. The whole tree is loaded eagerly. By default only
 * the top-level root is expanded (-); all of its children are collapsed (+)
 * with their grand-children hidden until the user expands them.
 *
 * Open/closed state is persisted per `storageKey`. When `activeTargetId`
 * matches a known leaf or matches a branch's `to`, that node's ancestors
 * auto-expand so the active node is visible.
 *
 * Leaves come in two flavors:
 *  - in-page anchor leaves (set `targetId`), used by per-page review rails;
 *  - router leaves (set `to`), rendered as react-router NavLinks.
 *
 * Branches may also have `to` (router target) and/or `targetId` (anchor),
 * which makes the branch label clickable just like a leaf.
 */

export interface TreeNavLeaf {
  kind: 'leaf'
  navKey: string
  label: string
  /** Anchor target id within the current page; used for href="#..." and for
   * scroll-spy style active matching. Required for in-page rails. */
  targetId?: string
  /** Router path (e.g. "/communications"). When set, the leaf renders as a
   * react-router NavLink and active state is driven by NavLink. */
  to?: string
  /** Optional trailing count rendered after the label, e.g. "(47)". */
  count?: number
}

export interface TreeNavBranch {
  kind: 'branch'
  navKey: string
  label: string
  /** Optional router path. If set the branch label itself is a NavLink. */
  to?: string
  /** Optional anchor target on the same page. If set the branch label is an
   * anchor that scrolls to that id. */
  targetId?: string
  /** When `to` is set, controls NavLink's `end` matching. Defaults to true
   * so only the exact-match branch highlights, not every ancestor. */
  end?: boolean
  /** Optional trailing count rendered after the label. */
  count?: number
  /** Whether this branch starts expanded if no persisted state exists.
   * In Windows-Explorer-style use, only the single root sets this true. */
  defaultOpen?: boolean
  children: TreeNavNode[]
}

export type TreeNavNode = TreeNavBranch | TreeNavLeaf

interface PersistedState {
  [navKey: string]: boolean
}

interface TreeNavProps {
  /**
   * Localstorage key for persisted open/closed state. Pass a packet-specific
   * key so two different review tools do not overwrite each other.
   */
  storageKey: string
  nodes: TreeNavNode[]
  /** Currently active leaf targetId (or active path for router nodes);
   * ancestors auto-expand. */
  activeTargetId?: string | null
  /** Click handler for anchor-style leaf navigation. */
  onNavigate?: (targetId: string) => void
}

function loadPersistedState(storageKey: string): PersistedState {
  if (typeof window === 'undefined' || !storageKey) {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: PersistedState = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'boolean') {
          result[key] = value
        }
      }
      return result
    }
  } catch {
    // ignore corrupt state
  }
  return {}
}

function persistState(storageKey: string, state: PersistedState): void {
  if (typeof window === 'undefined' || !storageKey) {
    return
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // ignore quota errors
  }
}

function collectDefaultOpen(nodes: TreeNavNode[], into: PersistedState): void {
  for (const node of nodes) {
    if (node.kind === 'branch') {
      into[node.navKey] = node.defaultOpen === true
      collectDefaultOpen(node.children, into)
    }
  }
}

function pathMatches(to: string, target: string): boolean {
  if (to === target) {
    return true
  }
  const trimmed = to.replace(/\/$/, '')
  if (!trimmed) {
    return false
  }
  return target.startsWith(`${trimmed}/`)
}

function findAncestorChain(
  nodes: TreeNavNode[],
  targetId: string,
  ancestors: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      if (node.targetId && node.targetId === targetId) {
        return ancestors
      }
      if (node.to && pathMatches(node.to, targetId)) {
        return ancestors
      }
      continue
    }
    if (node.to && pathMatches(node.to, targetId)) {
      // Branch itself matches - expand its ancestors but not itself.
      return ancestors
    }
    if (node.targetId && node.targetId === targetId) {
      return ancestors
    }
    const found = findAncestorChain(node.children, targetId, [...ancestors, node.navKey])
    if (found) {
      return found
    }
  }
  return null
}

function formatCount(count: number | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return ''
  }
  return ` (${count})`
}

interface BranchLabelProps {
  branch: TreeNavBranch
  isActiveByAnchor: boolean
  onAnchorNavigate?: (targetId: string) => void
}

function BranchLabel({ branch, isActiveByAnchor, onAnchorNavigate }: BranchLabelProps) {
  const labelContent = (
    <>
      {branch.label}
      <span className="tree-nav-count">{formatCount(branch.count)}</span>
    </>
  )
  if (branch.to) {
    return (
      <NavLink
        to={branch.to}
        end={branch.end ?? true}
        className={({ isActive }) => `tree-nav-branch-label is-link${isActive ? ' is-active' : ''}`}
      >
        {labelContent}
      </NavLink>
    )
  }
  if (branch.targetId) {
    const anchorId = branch.targetId
    return (
      <a
        href={`#${anchorId}`}
        className={`tree-nav-branch-label is-link${isActiveByAnchor ? ' is-active' : ''}`}
        aria-current={isActiveByAnchor ? 'location' : undefined}
        onClick={(event) => {
          if (!onAnchorNavigate) {
            return
          }
          event.preventDefault()
          onAnchorNavigate(anchorId)
        }}
      >
        {labelContent}
      </a>
    )
  }
  return <span className="tree-nav-branch-label">{labelContent}</span>
}

interface BranchProps {
  branch: TreeNavBranch
  depth: number
  openState: PersistedState
  toggle: (navKey: string) => void
  activeTargetId?: string | null
  onNavigate?: (targetId: string) => void
}

function Branch({ branch, depth, openState, toggle, activeTargetId, onNavigate }: BranchProps) {
  const hasChildren = branch.children.length > 0
  const isOpen = hasChildren && openState[branch.navKey] === true
  const padLeft = `${depth * 1.1}rem`
  const isActiveByAnchor = Boolean(
    branch.targetId && activeTargetId && branch.targetId === activeTargetId,
  )
  return (
    <div className="tree-nav-branch">
      <div className="tree-nav-row" style={{ paddingLeft: padLeft }}>
        {hasChildren ? (
          <button
            type="button"
            className="tree-nav-toggle"
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${branch.label}` : `Expand ${branch.label}`}
            onClick={() => toggle(branch.navKey)}
          >
            {isOpen ? '−' : '+'}
          </button>
        ) : (
          <span className="tree-nav-toggle-spacer" aria-hidden="true" />
        )}
        <BranchLabel
          branch={branch}
          isActiveByAnchor={isActiveByAnchor}
          onAnchorNavigate={onNavigate}
        />
      </div>
      {isOpen ? (
        <div className="tree-nav-children">
          {branch.children.map((child) =>
            child.kind === 'branch' ? (
              <Branch
                key={child.navKey}
                branch={child}
                depth={depth + 1}
                openState={openState}
                toggle={toggle}
                activeTargetId={activeTargetId}
                onNavigate={onNavigate}
              />
            ) : (
              <Leaf
                key={child.navKey}
                leaf={child}
                depth={depth + 1}
                activeTargetId={activeTargetId}
                onNavigate={onNavigate}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

interface LeafProps {
  leaf: TreeNavLeaf
  depth: number
  activeTargetId?: string | null
  onNavigate?: (targetId: string) => void
}

function Leaf({ leaf, depth, activeTargetId, onNavigate }: LeafProps) {
  // Pad the leaf so its label aligns under the branch label (past the +/- box).
  const padLeft = `${depth * 1.1 + 1.5}rem`
  if (leaf.to) {
    return (
      <div className="tree-nav-leaf-row" style={{ paddingLeft: padLeft }}>
        <NavLink
          to={leaf.to}
          end
          className={({ isActive }) => `tree-nav-leaf${isActive ? ' is-active' : ''}`}
        >
          {leaf.label}
          <span className="tree-nav-count">{formatCount(leaf.count)}</span>
        </NavLink>
      </div>
    )
  }
  const targetId = leaf.targetId ?? leaf.navKey
  const isActive = Boolean(activeTargetId) && targetId === activeTargetId
  return (
    <div className="tree-nav-leaf-row" style={{ paddingLeft: padLeft }}>
      <a
        href={`#${targetId}`}
        className={`tree-nav-leaf${isActive ? ' is-active' : ''}`}
        aria-current={isActive ? 'location' : undefined}
        onClick={(event) => {
          if (!onNavigate) {
            return
          }
          event.preventDefault()
          onNavigate(targetId)
        }}
      >
        {leaf.label}
        <span className="tree-nav-count">{formatCount(leaf.count)}</span>
      </a>
    </div>
  )
}

export function TreeNav({ storageKey, nodes, activeTargetId, onNavigate }: TreeNavProps) {
  const defaults = useMemo(() => {
    const state: PersistedState = {}
    collectDefaultOpen(nodes, state)
    return state
  }, [nodes])

  const [openState, setOpenState] = useState<PersistedState>(() => {
    const persisted = loadPersistedState(storageKey)
    return { ...defaults, ...persisted }
  })

  // When the active target changes, auto-expand its ancestors.
  useEffect(() => {
    if (!activeTargetId) {
      return
    }
    const chain = findAncestorChain(nodes, activeTargetId)
    if (!chain || chain.length === 0) {
      return
    }
    setOpenState((current) => {
      let changed = false
      const next = { ...current }
      for (const ancestor of chain) {
        if (next[ancestor] !== true) {
          next[ancestor] = true
          changed = true
        }
      }
      if (!changed) {
        return current
      }
      persistState(storageKey, next)
      return next
    })
  }, [activeTargetId, nodes, storageKey])

  const toggle = useCallback(
    (navKey: string) => {
      setOpenState((current) => {
        const next = { ...current, [navKey]: current[navKey] !== true }
        persistState(storageKey, next)
        return next
      })
    },
    [storageKey],
  )

  return (
    <nav className="tree-nav" aria-label="Section navigation">
      {nodes.map((node) =>
        node.kind === 'branch' ? (
          <Branch
            key={node.navKey}
            branch={node}
            depth={0}
            openState={openState}
            toggle={toggle}
            activeTargetId={activeTargetId}
            onNavigate={onNavigate}
          />
        ) : (
          <Leaf
            key={node.navKey}
            leaf={node}
            depth={0}
            activeTargetId={activeTargetId}
            onNavigate={onNavigate}
          />
        ),
      )}
    </nav>
  )
}
