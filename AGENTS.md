# Agent instructions for the `automation` repo

**MANDATORY FIRST READ — agent canon (re-read every session).**
Before doing anything in this repo, read the cross-repo canonical
agent rules. They live in **one** file, with no mirror and no copy in
this repo:

```
virusdave/top-level : docs/canon/AGENTS_CANON.md   (branch: master)
```

**You MUST read it from a freshly-cloned ephemeral checkout of
top-level's `master`, every session — do not read it any other way:**

```sh
canon_ws=$(/home/amp-local/src/github-worker/bin/ephemeral-checkout \
              /home/amp-local/src/top-level --label canon-read)
cat "$canon_ws/docs/canon/AGENTS_CANON.md"
# … apply the rules …
/home/amp-local/src/github-worker/bin/ephemeral-checkout --remove "$canon_ws"
```

Why this exact procedure, and not a shortcut:

- **Canon changes frequently** (operators add/modify rules mid-task),
  so a cached or remembered copy is stale almost immediately. Re-read
  it fresh at the start of every session — never paraphrase, cache, or
  copy it into this repo.
- **Do NOT `cat` the shared `~/src/top-level` working copy.** That tree
  is routinely stale: other agents work in ephemeral checkouts and
  nobody pulls there, so it can be many commits behind `origin/master`.
- The `ephemeral-checkout` tool clones the supplied path's `origin`
  **fresh from `master`** into a throwaway tree, so the file you read
  is guaranteed to be the latest published canon. That guarantee is the
  whole point of going through the tool rather than reading a local path.
- If the clone/read fails, **stop and report** — do not proceed on a
  guessed or remembered version of the rules.

That file is authoritative across all repos. It also documents the
canon-update interrupt: if the operator gives a rule that applies to
all agents/all repos ("canonical", "always", "never", "going forward",
…), persist it to `docs/canon/AGENTS_CANON.md` (via the same fresh
ephemeral checkout) before continuing — see `docs/canon/UPDATING_CANON.md`
in `virusdave/top-level`. The rest of this `AGENTS.md` only adds
**repo-specific** instructions and must not weaken or restate canon. If
canon and this file conflict, canon wins — update the stale one.

---

Everything below is repo-specific. The cross-repo rules it relies on
(no self-SSH, no manual service restarts, ephemeral-checkout-only,
default branch `master`, task-dag usage, no `--no-verify`, etc.) live
in canon — read it first.

## Host & deploy topology (canon §1)

- **You are almost always running directly on `vps-nixos-3`, the helios
  production host.** Run `hostname` to confirm, then run everything
  locally — do not self-SSH back into this box (canon §1).
- If you genuinely must SSH to a **different** fleet host, the port is
  **22223**, not 22.
- **Deploy helios** after `git push origin HEAD:master` with the
  mirror-aware wrapper — the only sanctioned way to roll helios (never
  restart `helios-prep` / `helios-server` / `helios-worker` by hand;
  that bypasses the mirror flip and serves user-visible 5xxs — canon §1):

  ```sh
  self-deploy-helios
  ```

  If `self-deploy-helios` itself errors, **stop and report** the exact
  output — do not "remediate" by restarting units. Verify locally
  afterward:

  ```sh
  systemctl is-active helios-prep.service helios-server.service helios-worker.service
  journalctl -u helios-prep.service -n 50 --no-pager
  curl -sSI https://helios.freshlybaked.us/healthzz
  ```

  (`helios-prep` is a oneshot; `inactive` after a clean run is normal.)

## Ephemeral checkout paths (canon §2)

The shared trees for this repo are `/home/amp-local/src/automation` and
its `helios/` subdir. Develop only in a throwaway checkout of them:

```sh
ws=$(/home/amp-local/src/github-worker/bin/ephemeral-checkout \
        /home/amp-local/src/automation --label <short-task-label>)
cd "$ws"
# … edit / build / test / commit / push HEAD:master …
/home/amp-local/src/github-worker/bin/ephemeral-checkout --remove "$ws"
```

## Pre-commit hook (one-time per clone)

This repo ships a `.githooks/` pre-commit gate that runs the helios
server typecheck + an in-process SPA smoke whenever a commit touches
`helios/`. Git won't auto-enable a tracked hooks dir, so run once:

```sh
git config core.hooksPath .githooks
```

The hook needs `helios/node_modules/` populated (`npm install` inside
`helios/`). Do not bypass it with `--no-verify` (canon §1); if it
fails, fix the cause or stop and report.

## Commit & push when done

Unlike the global default, in this repo you **commit AND push** finished
code/file work to `master` (`git push origin HEAD:master`) before
reporting completion — don't leave a clean-but-unpushed tree for the
human. If something genuinely blocks the push, stop and loudly report
the exact error and your proposed next step rather than continuing
silently.

## Git-DAG tasks — `scripts/task-dag` (canon §2)

Canon mandates the task-dag system where a repo has it and forbids
tombstone commits for new work. Repo specifics:

- An issue is task-tracked once `github-actions` posts a
  `Task metadata commit:` comment and `tasks/frontier/<sha>` refs exist.
- Workflow:

  ```sh
  scripts/task-dag frontier [--issue=N]        # pick a ready leaf → its <task-sha>
  scripts/task-dag claim <task-sha> --note='…' # claim BEFORE reading any file
  # … make the real implementation change, commit it normally …
  scripts/task-dag complete <task-sha>         # links the commit, writes trailers, retires refs
  git push origin HEAD:master
  ```

- **Claim before you read a single file.** It's an atomic CAS on
  `origin`; a lost race exits non-zero (`2` race-lost, `3` no-frontier,
  `4` push-failed → retry). Picking a SHA off `frontier` is not a claim,
  and skipping this once had three agents implement the same task.
- Can't finish a claimed task? `scripts/task-dag release <task-sha>`
  before tearing down your workspace — a stuck `tasks/active/<sha>`
  blocks every other agent on it.
- Let `complete` author the `Related:` / `Task-Commit:` / `Issue:`
  trailers; never hand-craft parent links or use `--allow-empty`
  tombstones for work you just did.

## Public URL for viewable artifacts

Any HTML page / report / dashboard / downloadable bundle a human needs
to look at must end with a working public URL:

```sh
scripts/upload-to-mss <file> "<note>" <ttl>   # oauth-proxied mss-one-offs; ttl usually 86400
```

Redeploy and resurface the new URL after **every** change to the
artifact, and verify it's reachable (`curl -sSI` returns 2xx/3xx)
before reporting it. If you can't produce a URL (host down, perms,
extra infra), say so loudly and explain the blocker.

## NY timezone (America/New_York) for all aggregation & display

Every store is in NYC, every transaction happens in NY wall-clock, and
every operator reasons about "today" / "this week" / "this hour" in NY
local time. Therefore — **unless the user explicitly says otherwise** —
**all aggregate bucketing AND all UI display must be in `America/New_York`**.

This applies everywhere, not just metrics: chart tooltips, X-axis tick
labels, scatter readouts, table date columns, popup "last seen at"
strings, log timestamps surfaced in the UI, day/week/month roll-ups in
SQL, cohort keys, anything.

Concrete rules:

- **Server-side SQL**: bucket / `date_trunc` against `pay_time AT TIME
  ZONE 'America/New_York'`, casting back to `timestamptz` if you need
  to round-trip. The canonical examples live in
  `helios/src/server/metrics/timeBuckets.ts` and
  `helios/src/server/metrics/bucketSelectSql.ts`.
- **Client-side display**: NEVER use `getUTCHours()` / `getUTCDate()`,
  NEVER use a timezone-less `toLocaleString()`. Use the helpers in
  `helios/src/client/app/nyTime.ts` (`nyShortDateTime`, `nyLongDateTime`,
  `nyHourTick`, `nyMonthDayTick`, `nyMonthYearTick`, `nyIsoDate`,
  `nyParts`, `nyFloorToDay`, `nyFloorToWeek`, `nyFloorToMonth`,
  `nyFloorToHour`, `nyAddDays`, `nyAddMonthsFromFirst`). They all
  pin to `Intl.DateTimeFormat` with `timeZone: 'America/New_York'`
  so EST↔EDT transitions Just Work via the browser's bundled ICU.
- **One-off display code** that genuinely cannot pull in `nyTime.ts`
  (e.g. a stand-alone script outputting an HTML report) must still
  explicitly pass `{ timeZone: 'America/New_York' }` to every
  `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`
  call, plus an explicit locale (`'en-US'`) so output is deterministic
  across runners.
- **Browser-local time is wrong by default**. The operator's laptop
  might be on PT, CT, or even outside the US. Pinning to NY makes
  every cell in the UI show the same value the register tape would
  print, regardless of who's looking at the screen.

If you find UTC-based display or browser-local-time display anywhere
in the codebase, fix it as part of whatever you're already doing
there. Don't leave broken NY-vs-UTC inconsistencies behind because
"that wasn't in scope".

The narrow exception: the **hour-grain server buckets** in
`timeBuckets.ts` are deliberately UTC top-of-hour to disambiguate the
fall-back duplicate `01:00` NY hour. The display layer still renders
the resulting UTC hour as its NY wall-clock equivalent via
`nyHourTick` / `nyShortDateTime`. That's the only place "UTC for
aggregate" is allowed, and it ships with a comment explaining why.

## Sweed auth — claim a token from the pool, never paste a static secret

There is **no** static `~/.secret/sweed/auth-token`. Sweed's
`store.auth.user` is reCAPTCHA-gated, so an operator pastes captured
browser sessions into the helios `sweed_session_tokens` pool
(<https://helios.freshlybaked.us/config/sweed/sessions>) and each
worker / one-off claims one row for the lifetime of one task and
releases it.

If your task touches live Sweed RPCs:

1. Put the script under `helios/scripts/` and import
   [`withSweedSession`](./helios/src/worker/sweed/session.ts) — it does
   claim + release + dealer pinning + auth-event audit for you.
2. Set `DATABASE_URL` to the helios Tiger Cloud URL (from
   `/home/amp-local/.secret/tigerdata/tiger-cloud-db-94793-credentials.txt`
   on the prod host) so the helper can reach the pool.
3. **Never** invent a `SWEED_AUTH_TOKEN` from a captured cookie — it
   goes stale in days and future readers copy the anti-pattern. If you
   truly can't use the helper, drive the same SQL as
   [`claimAvailableSweedSessionToken`](./helios/src/server/db/queries/sweedSessionTokensQueries.ts)
   and release in a `try/finally`.

Full instructions + the canonical harness
([`helios/scripts/verify-sweed-session.ts`](./helios/scripts/verify-sweed-session.ts))
are in
[`docs/sweed/getting-a-token-for-one-offs.md`](./docs/sweed/getting-a-token-for-one-offs.md).
If the pool is exhausted, `withSweedSession` throws
`DependencyUnavailableWorkerError` rather than handing you a stale
fallback — back off and retry, or ask the operator to paste a live
session.

## Paging the operator — always `page-dave`, never `gh`

To page / notify / alert Dave (deploy ready for on-device check, a
blocking decision, a long job finished), use the installed CLI:

```sh
page-dave -p <priority> -t "<short title>" "<message body>"
```

- `-p`: ntfy priority `1`–`5` (or `min`/`low`/`default`/`high`/`max`).
  Use `4` (high) for most completion pages, `5` (max) only to unblock
  work needing immediate attention, `3` for routine FYIs.
- `-t`: short banner headline. Final positional arg is the body (don't
  prefix it with the priority number).

A `gh issue comment` is **not** paging — GitHub notifications aren't a
pager. A comment can accompany a page (to persist context) but never
substitutes for one. If `page-dave` isn't on `$PATH`, say so loudly
rather than silently posting a `gh` comment and claiming you paged.
