import type { TreeNavNode } from '../../components/TreeNav.js'

/**
 * Shared sidebar subtree for the Ads (communications) module. Any page
 * under /communications/* that wants the common ops leaves (Drive ingest,
 * etc.) to stay visible should register this via
 * `useRegisterSidebarSubtree('communications', COMMUNICATIONS_SIDEBAR_SUBTREE)`.
 *
 * Page-specific subtrees (e.g. PolicyReplacementReviewPage's anchor-style
 * Review > Assets tree) override this by registering their own subtree.
 */
export const COMMUNICATIONS_SIDEBAR_SUBTREE: TreeNavNode[] = [
  {
    kind: 'leaf',
    navKey: 'communications.drive-ingest',
    label: 'Drive ingest',
    to: '/communications/drive-ingest',
  },
]
