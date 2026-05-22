import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Customer-Sentiment Capture module
 * (issue #13). Any page under /reviews/* registers this via
 * `useRegisterSidebarSubtree('reviews', REVIEWS_SIDEBAR_SUBTREE)`
 * so the same leaves stay visible across the module.
 *
 * A1 ships only the list page. A5 will add the /reviews/drawing
 * exportable list.
 */
export const REVIEWS_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'reviews.list',
    label: 'Submissions',
    to: '/reviews',
  },
]
