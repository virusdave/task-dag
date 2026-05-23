import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Customer-Sentiment Capture module
 * (issue #13). Any page under /reviews/* registers this via
 * `useRegisterSidebarSubtree('reviews', REVIEWS_SIDEBAR_SUBTREE)`
 * so the same leaves stay visible across the module.
 *
 * A1 shipped the read-only Submissions list. A5 adds the
 * /reviews/drawing exportable list + acknowledge workflow.
 */
export const REVIEWS_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'reviews.list',
    label: 'Submissions',
    to: '/reviews',
  },
  {
    kind: 'leaf',
    navKey: 'reviews.drawing',
    label: 'Drawing',
    to: '/reviews/drawing',
  },
]
