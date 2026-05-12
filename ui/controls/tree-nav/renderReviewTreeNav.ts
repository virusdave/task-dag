export interface ReviewTreeNavNode {
  childCount: number
  children: ReviewTreeNavNode[]
  defaultOpen?: boolean
  key: string
  labelHtml: string
  selfLinkLabel: string
  targetId: string
  tone?: 'group' | 'node'
}

export interface ReviewTreeNavRenderOptions {
  ariaLabel: string
  description: string
  hideButtonLabel?: string
  title: string
}

export function renderReviewTreeNav(
  nodes: ReviewTreeNavNode[],
  options: ReviewTreeNavRenderOptions,
): string {
  return `
    <nav class="review-tree-nav" aria-label="${escapeHtml(options.ariaLabel)}" data-review-tree-nav-root>
      <div class="review-tree-nav-header">
        <div>
          <strong>${escapeHtml(options.title)}</strong>
          <div class="muted">${escapeHtml(options.description)}</div>
        </div>
        <button type="button" class="review-tree-nav-toggle" data-review-tree-nav-hide>${escapeHtml(options.hideButtonLabel ?? 'Hide nav')}</button>
      </div>
      <div class="review-tree-nav-tree" data-review-tree-nav-tree>
        ${nodes.map((node) => renderReviewTreeNavNode(node)).join('')}
      </div>
    </nav>
  `
}

function renderReviewTreeNavNode(node: ReviewTreeNavNode): string {
  const countLabel = `${node.childCount} row${node.childCount === 1 ? '' : 's'}`
  const itemClass = node.tone === 'group' ? 'review-tree-nav-group' : 'review-tree-nav-node'
  const defaultOpen = node.defaultOpen === true ? ' open' : ''

  return `
    <details class="${itemClass}" data-nav-key="${escapeHtml(node.key)}" data-review-tree-nav-item data-review-tree-nav-target-id="${escapeHtml(node.targetId)}"${defaultOpen}>
      <summary>
        <span class="review-tree-nav-summary-row">
          <span class="review-tree-nav-summary-label">${node.labelHtml}</span>
          <span class="review-tree-nav-count">${countLabel}</span>
        </span>
      </summary>
      <div class="review-tree-nav-links">
        <a href="#${escapeHtml(node.targetId)}" class="review-tree-nav-link" data-review-tree-nav-link data-review-tree-nav-target-id="${escapeHtml(node.targetId)}">${escapeHtml(node.selfLinkLabel)}</a>
        ${node.children.map((child) => renderReviewTreeNavNode(child)).join('')}
      </div>
    </details>
  `
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
