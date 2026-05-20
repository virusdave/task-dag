# Getting a Sweed auth token for one-off tasks

**Read this whenever a script needs to call Sweed RPCs from an
agent shell, a CLI tool, or a one-off Node/Python script.**

## TL;DR

- **There is no static `~/.secret/sweed/auth-token` anymore.** Do
  not paste one. Do not set `SWEED_AUTH_TOKEN` from a file you found
  on disk — it will be stale and every RPC will fail with
  `Auth expired`.
- All live Sweed tokens live in the helios `sweed_session_tokens`
  table (the **pool**). An operator pastes captured browser sessions
  into `/config/sweed/sessions`; workers and one-off scripts claim
  one row out of the pool for the lifetime of one job, then release
  it back.
- For one-off work, **import [`withSweedSession`](../../helios/src/worker/sweed/session.ts)**
  inside a script that lives under `helios/scripts/` and let it
  handle the claim/release lifecycle. Do not re-implement claim
  SQL by hand unless you have a very specific reason.

## Why we no longer ship a static secret

Sweed's `store.auth.user` endpoint is gated by Google reCAPTCHA v3
and rejects unattended login attempts. There is no machine-mintable
service token. The only way to get a working session is to capture
the `auth=...` UUID from a real logged-in browser. Pre-pool, we
stashed a single captured token in `~/.secret/sweed/auth-token` per
agent host; that secret went stale every few weeks and every job on
the host then died with `Auth expired` until someone re-pasted by
hand.

The pool fixes both problems:

- **Multiple live tokens at once** — an operator can paste several
  captured sessions and the pool hands them out one-per-job. No
  shared-dealer-context races.
- **Auth-expired self-heals at the row** — when a token starts
  returning auth errors the transport layer marks that one row
  `marked_expired_at`; other live rows keep working and the operator
  only needs to paste a replacement, not rotate a host-wide secret.

## How to claim a token for a one-off script

The canonical example is [`helios/scripts/verify-sweed-session.ts`](../../helios/scripts/verify-sweed-session.ts).
The shape is always:

```ts
import { ensureDealerContext, callSweedRpcRaw } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'

await withSweedSession(async () => {
  // Pin the session to whichever site you need:
  await ensureDealerContext(210705) // Midtown · 210249 Bronx · 210248 State holder

  // ...your read-only RPCs here...
  const inv = await callSweedRpcRaw('store.inventory.item.list.grouped', {
    page: 1, pageSize: 200,
  })
})
// Token is automatically released back to the pool on success OR throw.
```

`withSweedSession` does three things:

1. Claims one available row from `sweed_session_tokens` via
   `select ... for update skip locked`, with a 15-minute lease.
2. Runs your block with that token + the captured initial dealer
   pinned in AsyncLocalStorage so every downstream `callSweedRpc*`
   uses the same row.
3. **Always** releases the row back to the pool in `finally` — no
   `store.auth.end` is ever issued, the operator-pasted token must
   keep working for the next claimer.

If the pool is exhausted (every row leased to a concurrent job)
`withSweedSession` throws `DependencyUnavailableWorkerError` rather
than handing out a stale fallback — back off and retry, or ask the
operator to paste another session at `/config/sweed/sessions`.

## How to run a one-off script on the prod helios host

```sh
# (1) Spin up an ephemeral checkout — never edit ~/src/automation directly
ws=$(/home/amp-local/src/github-worker/bin/ephemeral-checkout \
        /home/amp-local/src/automation \
        --label my-task)
cd "$ws"

# (2) Symlink helios node_modules (already built on this host)
ln -s /home/amp-local/src/automation/helios/node_modules helios/node_modules

# (3) Point the script at the helios DB so it can reach the pool.
#     The Tiger Cloud URL is in /home/amp-local/.secret/tigerdata/.
export DATABASE_URL="$(grep '^Service URL:' \
  /home/amp-local/.secret/tigerdata/tiger-cloud-db-94793-credentials.txt \
  | sed 's/^Service URL: *//')"

# (4) Run from helios/ so the relative .js imports resolve
cd helios
npx tsx scripts/<your-script>.ts
```

If you only need to confirm the pool is healthy without writing
your own script, just run the canonical harness:

```sh
npx tsx scripts/verify-sweed-session.ts
```

It will print `PASS source=db-pasted rowId=<n> ...` if the pool
hands you a working token.

## When you genuinely cannot use `withSweedSession`

If you're outside `helios/` (e.g. a Python script in `catalog/` or
`scripts/`) and importing `withSweedSession` is impractical, you
have two acceptable fallbacks, in order of preference:

1. **Move the script into `helios/scripts/`** and use the canonical
   helper. This is almost always the right answer for new work.
2. **Drive the same SQL the helper drives.** See
   [`helios/src/server/db/queries/sweedSessionTokensQueries.ts`](../../helios/src/server/db/queries/sweedSessionTokensQueries.ts)
   for the exact `claimAvailableSweedSessionToken` and
   `releaseSweedSessionToken` queries. Use the same `for update
   skip locked` pattern, write a `claimed_by` tag identifying your
   script + pid, and **always** release in a `try/finally`.

What you must **not** do:

- Paste a captured `auth=...` cookie into a script as a literal
  string. It will be stale within days, and worse, future readers
  will copy the pattern.
- Re-introduce `~/.secret/sweed/auth-token` "just for this run." The
  whole point of the pool is that there is no host-wide static
  secret to drift out of date.
- Skip the release. A leaked claim ties up a pool row until its
  lease (default 15 min) expires; under load that can block other
  workers from running.

## Operator workflow (for completeness)

When the pool is empty or you have explicit reason to enlarge it:

1. In a real browser logged in to <https://prime.sweedpos.com>,
   open DevTools → Application → Cookies and copy the `auth` UUID.
2. Visit <https://helios.freshlybaked.us/config/sweed/sessions>.
3. Paste the UUID. The server validates it with a no-op
   `store.auth.initial.data.get` before committing it active, so
   you get an immediate "dead token" error if you pasted the wrong
   value.
4. The row is now available for the next worker / one-off script to
   claim.
