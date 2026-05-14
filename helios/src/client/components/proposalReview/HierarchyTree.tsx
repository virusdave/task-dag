/**
 * Hierarchical navigation tree for proposals.
 *
 * Displays site → catalog → brand → item hierarchy with counts
 * and allows filtering by hierarchy level.
 */

import { useState } from 'react'
import type { HierarchyNode } from '../../../shared/contracts/ui/proposalReview.js'

export interface HierarchyTreeProps {
  root: HierarchyNode[]
  onNodeSelect: (nodeId: string, nodeType: HierarchyNode['type']) => void
  selectedNodeId: string | null
}

export function HierarchyTree({ root, onNodeSelect, selectedNodeId }: HierarchyTreeProps) {
  return (
    <div className="hierarchy-tree">
      <h3>Filter by Hierarchy</h3>
      {root.map((node) => (
        <HierarchyNodeComponent
          key={node.id}
          node={node}
          onNodeSelect={onNodeSelect}
          selectedNodeId={selectedNodeId}
        />
      ))}
    </div>
  )
}

interface HierarchyNodeComponentProps {
  node: HierarchyNode
  onNodeSelect: (nodeId: string, nodeType: HierarchyNode['type']) => void
  selectedNodeId: string | null
  depth?: number
}

function HierarchyNodeComponent({
  node,
  onNodeSelect,
  selectedNodeId,
  depth = 0,
}: HierarchyNodeComponentProps) {
  const [isExpanded, setIsExpanded] = useState(node.isExpanded)
  const hasChildren = node.children.length > 0
  const isSelected = selectedNodeId === node.id

  const handleClick = () => {
    if (hasChildren) {
      setIsExpanded(!isExpanded)
    }
    onNodeSelect(node.id, node.type)
  }

  const iconClass = getIconClass(node.type)
  const depthPadding = depth * 1.2

  return (
    <div className="hierarchy-node">
      <button
        className={`hierarchy-node-button ${isSelected ? 'is-selected' : ''}`}
        onClick={handleClick}
        style={{ paddingLeft: `${depthPadding}rem` }}
        type="button"
      >
        {hasChildren && (
          <span className={`expand-icon ${isExpanded ? 'expanded' : ''}`}>▸</span>
        )}
        <span className={`node-icon ${iconClass}`} />
        <span className="node-label">{node.label}</span>
        <span className="node-count">{node.itemCount}</span>
      </button>
      {isExpanded && hasChildren && (
        <div className="hierarchy-children">
          {node.children.map((child) => (
            <HierarchyNodeComponent
              key={child.id}
              node={child}
              onNodeSelect={onNodeSelect}
              selectedNodeId={selectedNodeId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function getIconClass(type: HierarchyNode['type']): string {
  switch (type) {
    case 'site':
      return 'icon-site'
    case 'catalog':
      return 'icon-catalog'
    case 'brand':
      return 'icon-brand'
    case 'item':
      return 'icon-item'
    default:
      return 'icon-default'
  }
}
