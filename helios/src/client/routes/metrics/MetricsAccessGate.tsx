import type { ReactNode } from 'react'
import { Link, useRouteLoaderData } from 'react-router-dom'

import type { MetricGrantKey, SessionEnvelope } from '../../../shared/contracts/index.js'
import { userHasAnyMetricGrant } from '../../../shared/domain/metricGrants.js'

// Inline client-side gate for metric-namespaced pages.
//
// Server is the authority on every metric API; this component just
// avoids loading-state UI flicker and gives a clean explanatory page
// when an operator follows a stale link or bookmark to a metrics
// surface they don't have access to. If a user with the wrong
// grants somehow lands on a gated route, the underlying API calls
// would 403 — this component surfaces the same denial up-front so
// the page doesn't render an empty / error-strewn shell first.
//
// Admins implicitly hold every grant (see userHasMetricGrant);
// this component delegates to the shared helper so the check stays
// in lockstep with the server-side requireMetricsGrant logic.

export interface MetricsAccessGateProps {
  /** Render the children iff the user has at least one of these grants. */
  readonly anyOf: ReadonlyArray<MetricGrantKey>
  /** Optional override for the denial header. */
  readonly surfaceLabel?: string
  readonly children: ReactNode
}

export function MetricsAccessGate({
  anyOf,
  surfaceLabel,
  children,
}: MetricsAccessGateProps) {
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const user = session?.user ?? null
  if (userHasAnyMetricGrant(user, anyOf)) {
    return <>{children}</>
  }
  return <MetricsAccessDenied anyOf={anyOf} surfaceLabel={surfaceLabel} hasUser={!!user} />
}

function MetricsAccessDenied({
  anyOf,
  surfaceLabel,
  hasUser,
}: {
  readonly anyOf: ReadonlyArray<MetricGrantKey>
  readonly surfaceLabel?: string
  readonly hasUser: boolean
}) {
  return (
    <section className="metrics-dashboard">
      <header className="page-header metrics-dashboard-header">
        <div>
          <p className="eyebrow">Metrics access</p>
          <h2>{surfaceLabel ? `${surfaceLabel} — restricted` : 'Restricted'}</h2>
        </div>
      </header>
      <article className="history-card" style={{ marginTop: 16 }}>
        {hasUser ? (
          <>
            <p>
              You don't currently have access to this metrics surface.
              Required grant{anyOf.length === 1 ? '' : 's'}:{' '}
              <code>{anyOf.join(' OR ')}</code>.
            </p>
            <p className="subtle-copy">
              Ask an admin to grant access on{' '}
              <Link to="/config/users">/config/users</Link>. Admins
              implicitly have every metrics grant.
            </p>
          </>
        ) : (
          <p>
            You are signed out. Please <Link to="/login">sign in</Link>{' '}
            to view metrics.
          </p>
        )}
      </article>
    </section>
  )
}
