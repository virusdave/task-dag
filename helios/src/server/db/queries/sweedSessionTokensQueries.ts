import type { Queryable } from '../pool.js'
import type { SweedSessionToken } from '../../../shared/contracts/index.js'

interface SweedSessionTokenRow {
  id: string | number
  created_at: Date
  token: string
  token_prefix: string
  label: string | null
  source: string
  created_by_user_id: string | number | null
  created_by_label: string | null
  marked_expired_at: Date | null
  expired_reason: string | null
  initial_dealer_id: string | number | null
  claimed_at: Date | null
  claimed_by: string | null
  claim_expires_at: Date | null
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : String(value)
}

function rowToToken(row: SweedSessionTokenRow, options: { revealToken: boolean }): SweedSessionToken {
  const now = Date.now()
  const isActive = row.marked_expired_at === null
  const claimLeaseStillValid =
    row.claimed_at !== null &&
    (row.claim_expires_at === null || row.claim_expires_at.getTime() > now)
  const isClaimed = isActive && claimLeaseStillValid
  const isAvailable = isActive && !claimLeaseStillValid
  return {
    id: Number(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    token: options.revealToken ? row.token : null,
    tokenPrefix: row.token_prefix,
    label: row.label,
    source: row.source,
    createdByUserId: row.created_by_user_id === null ? null : Number(row.created_by_user_id),
    createdByLabel: row.created_by_label,
    markedExpiredAt: toIsoOrNull(row.marked_expired_at),
    expiredReason: row.expired_reason,
    initialDealerId: row.initial_dealer_id === null ? null : Number(row.initial_dealer_id),
    claimedAt: toIsoOrNull(row.claimed_at),
    claimedBy: row.claimed_by,
    claimExpiresAt: toIsoOrNull(row.claim_expires_at),
    isActive,
    isClaimed,
    isAvailable,
  }
}

const SELECT_COLUMNS = `
  t.id,
  t.created_at,
  t.token,
  t.token_prefix,
  t.label,
  t.source,
  t.created_by_user_id,
  u.name as created_by_label,
  t.marked_expired_at,
  t.expired_reason,
  t.initial_dealer_id,
  t.claimed_at,
  t.claimed_by,
  t.claim_expires_at
`

export interface ClaimedSweedSessionToken {
  id: number
  token: string
  tokenPrefix: string
  initialDealerId: number | null
  claimedBy: string
  claimExpiresAt: Date
}

/**
 * Atomically pull one available row out of the pool, mark it as
 * claimed by `claimedBy` with a `ttlMs` lease, and return it. Uses
 * `for update skip locked` so concurrent workers never race onto the
 * same row.
 *
 * "Available" means:
 *   marked_expired_at is null
 *   AND (claimed_at is null OR claim_expires_at <= now())
 *
 * Returns null when the pool is empty (no unexpired rows) OR every
 * unexpired row is currently leased to another worker. Callers
 * should surface the empty-pool case to the operator: paste another
 * session token via /config/sweed/sessions.
 *
 * Tolerates the table or claim columns being absent (migrations
 * 014/015 not applied) by returning null.
 */
export async function claimAvailableSweedSessionToken(
  db: Queryable,
  options: { claimedBy: string; ttlMs: number },
): Promise<ClaimedSweedSessionToken | null> {
  // The claim MUST be performed in a single SQL statement.
  //
  // We callers pass a `pg.Pool` (see getPool()), not a checked-out
  // PoolClient — so each `pool.query()` may run on a DIFFERENT
  // backend connection, and a multi-statement
  // BEGIN / SELECT ... FOR UPDATE SKIP LOCKED / UPDATE / COMMIT
  // does NOT actually share a transaction or hold the row lock
  // across statements. Two concurrent workers could both pass the
  // SELECT, both UPDATE, both end up holding the SAME pool row,
  // and therefore both hand out the SAME Sweed auth token. That
  // breaks the "private token per job" invariant the rest of the
  // Sweed runtime relies on for dealer-context partitioning, and
  // shows up as `store.screen.carousel.banner.list: Action does
  // not exist or you do not have permission` (subcode 14002) on
  // the screen-banner bounce job when a concurrent catalog job
  // flips the shared token to the state dealer.
  //
  // The CTE below performs the candidate selection (with row-level
  // SKIP LOCKED) AND the claiming UPDATE in one atomic statement
  // on one connection, so exclusivity is guaranteed regardless of
  // how the Queryable manages connections.
  try {
    const claimed = await db.query<{
      id: string | number
      token: string
      token_prefix: string
      initial_dealer_id: string | number | null
      claimed_by: string
      claim_expires_at: Date
    }>(
      `
        with candidate as (
          select id
          from sweed_session_tokens
          where marked_expired_at is null
            and (claimed_at is null or claim_expires_at <= now())
          order by created_at asc, id asc
          for update skip locked
          limit 1
        )
        update sweed_session_tokens t
           set claimed_at       = now(),
               claimed_by       = $1,
               claim_expires_at = now() + ($2::int * interval '1 millisecond')
          from candidate
         where t.id = candidate.id
        returning t.id, t.token, t.token_prefix, t.initial_dealer_id, t.claimed_by, t.claim_expires_at
      `,
      [options.claimedBy, options.ttlMs],
    )
    const row = claimed.rows[0]
    if (row === undefined) {
      return null
    }
    return {
      id: Number(row.id),
      token: row.token,
      tokenPrefix: row.token_prefix,
      initialDealerId: row.initial_dealer_id === null ? null : Number(row.initial_dealer_id),
      claimedBy: row.claimed_by,
      claimExpiresAt: row.claim_expires_at,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      /relation .*sweed_session_tokens.* does not exist/i.test(message) ||
      /column .*(claimed_at|claimed_by|claim_expires_at).* does not exist/i.test(message)
    ) {
      return null
    }
    throw error
  }
}

/**
 * Release a previously-claimed pool row back to the pool. Only
 * clears the claim fields if `claimedBy` still matches (so a stale
 * release from a process whose lease lapsed and was reclaimed by
 * someone else is a no-op). Idempotent.
 */
export async function releaseSweedSessionToken(
  db: Queryable,
  options: { id: number; claimedBy: string },
): Promise<void> {
  try {
    await db.query(
      `update sweed_session_tokens
          set claimed_at = null,
              claimed_by = null,
              claim_expires_at = null
        where id = $1 and claimed_by = $2`,
      [options.id, options.claimedBy],
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      /relation .*sweed_session_tokens.* does not exist/i.test(message) ||
      /column .*(claimed_at|claimed_by|claim_expires_at).* does not exist/i.test(message)
    ) {
      return
    }
    throw error
  }
}

export async function listSweedSessionTokens(
  db: Queryable,
  options: { limit: number; revealActiveToken: boolean },
): Promise<{ items: SweedSessionToken[]; active: SweedSessionToken | null }> {
  try {
    const result = await db.query<SweedSessionTokenRow>(
      `
        select ${SELECT_COLUMNS}
        from sweed_session_tokens t
        left join users u on u.id = t.created_by_user_id
        order by t.created_at desc, t.id desc
        limit $1
      `,
      [options.limit],
    )
    const items = result.rows.map((row) => rowToToken(row, { revealToken: false }))
    // "active" in the pool model just means "we have at least one
    // unexpired row to show the operator". Pick the most recently
    // created unexpired row as the representative entry.
    const activeRow = result.rows.find((row) => row.marked_expired_at === null) ?? null
    const active = activeRow ? rowToToken(activeRow, { revealToken: options.revealActiveToken }) : null
    return { items, active }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*sweed_session_tokens.* does not exist/i.test(message)) {
      return { items: [], active: null }
    }
    throw error
  }
}

export interface InsertSweedSessionTokenInput {
  token: string
  tokenPrefix: string
  label: string | null
  source: string
  createdByUserId: number | null
  initialDealerId: number | null
}

/**
 * Add a new token to the pool. In the pool model this does NOT
 * supersede existing unexpired rows — operators can stage several
 * concurrent tokens so workers always have something to claim.
 *
 * Pasting a duplicate (same token_prefix as an existing row) returns
 * the existing row, un-expiring it if necessary so it goes back into
 * the available pool. We don't want to spawn duplicate rows when an
 * operator clicks the bookmarklet twice.
 */
export async function insertSweedSessionToken(
  db: Queryable,
  input: InsertSweedSessionTokenInput,
): Promise<SweedSessionToken> {
  const existing = await db.query<SweedSessionTokenRow>(
    `
      select ${SELECT_COLUMNS}
      from sweed_session_tokens t
      left join users u on u.id = t.created_by_user_id
      where t.token_prefix = $1
      limit 1
    `,
    [input.tokenPrefix],
  )
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (row.marked_expired_at !== null) {
      await db.query(
        `update sweed_session_tokens
            set marked_expired_at = null, expired_reason = null
          where id = $1`,
        [row.id],
      )
      row.marked_expired_at = null
      row.expired_reason = null
    }
    return rowToToken(row, { revealToken: true })
  }

  const inserted = await db.query<{ id: string | number }>(
    `
      insert into sweed_session_tokens (
        token, token_prefix, label, source, created_by_user_id, initial_dealer_id
      ) values ($1, $2, $3, $4, $5, $6)
      returning id
    `,
    [input.token, input.tokenPrefix, input.label, input.source, input.createdByUserId, input.initialDealerId],
  )
  const id = Number(inserted.rows[0]!.id)
  const fresh = await db.query<SweedSessionTokenRow>(
    `select ${SELECT_COLUMNS}
       from sweed_session_tokens t
       left join users u on u.id = t.created_by_user_id
      where t.id = $1`,
    [id],
  )
  return rowToToken(fresh.rows[0]!, { revealToken: true })
}

/**
 * Permanently retire a specific pool row. Idempotent — if another
 * caller already expired it the original timestamp/reason are kept.
 */
export async function markSweedSessionTokenExpired(
  db: Queryable,
  id: number,
  reason: string,
): Promise<void> {
  await db.query(
    `update sweed_session_tokens
        set marked_expired_at = coalesce(marked_expired_at, now()),
            expired_reason    = coalesce(expired_reason, $2),
            claimed_at        = null,
            claimed_by        = null,
            claim_expires_at  = null
      where id = $1`,
    [id, reason],
  )
}
