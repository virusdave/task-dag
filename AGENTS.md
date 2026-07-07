# Agent instructions for the `automation` repo

**MANDATORY FIRST READ — agent canon (re-read every session).** Before
doing anything in this repo, read the cross-repo canonical agent rules
fresh from a throwaway ephemeral checkout of `virusdave/top-level` at
`origin/master` (never the stale shared `~/src/top-level`):

```sh
cw=$(/home/amp-local/src/top-level/scripts/ephemeral_checkout \
        top-level --label canon-read)
cat "$cw/docs/canon/AGENTS_CANON.md"
# … apply the rules; follow the Core's §4 dispatch table into rules/ …
/home/amp-local/src/top-level/scripts/ephemeral_checkout --remove "$cw"
```

That file is the **Canon Core**: read it in full, then follow its §4
dispatch table to the relevant `docs/canon/rules/*` docs for your task.
It changes frequently; never cache or paraphrase it. Your final work
must include the **Agent Gate Record** (Core §3, template at
`docs/canon/templates/AGENT_GATE_RECORD.md`). If anything below
conflicts with canon, **canon wins** — fix the stale prose here.

---

Everything below is repo-specific. The cross-repo rules it relies on
(no self-SSH, no manual service restarts, ephemeral-checkout-only,
default branch `master`, task-dag usage, no `--no-verify`, the Agent
Gate Record, etc.) live in canon — read it first.

## Host & deploy topology (canon: rules/SAFETY.md)

- **You are almost always running directly on `vps-nixos-3`, the helios
  production host.** Run `hostname` to confirm, then run everything
  locally — do not self-SSH back into this box (canon: rules/SAFETY.md).
- If you genuinely must SSH to a **different** fleet host, the port is
  **22223**, not 22.
- **Deploy helios** after `git push origin HEAD:master` with the
  mirror-aware wrapper — the only sanctioned way to roll helios (never
  restart `helios-prep` / `helios-server` / `helios-worker` by hand;
  that bypasses the mirror flip and serves user-visible 5xxs — canon: rules/SAFETY.md):

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

## Ephemeral checkout paths (canon: rules/WORKFLOW.md)

The shared trees for this repo are `/home/amp-local/src/automation` and
its `helios/` subdir. Develop only in a throwaway checkout of them:

```sh
ws=$(/home/amp-local/src/top-level/scripts/ephemeral_checkout \
        automation --label <short-task-label>)
cd "$ws"
# … edit / build / test / commit / push HEAD:master …
/home/amp-local/src/top-level/scripts/ephemeral_checkout --remove "$ws"
```

## Pre-commit hook (one-time per clone)

This repo ships a `.githooks/` pre-commit gate. Git won't auto-enable a
tracked hooks dir, so run once:

```sh
git config core.hooksPath .githooks
```

It runs three instant repo-wide scanners on **every** commit
(`scan-explicit-any`, `scan-disabled-gates`, `scan-test-resources` — a
weakened gate anywhere is a master breakage), and adds package-scoped
checks only when the staged files touch a package: helios server
typecheck + client typecheck + in-process SPA smoke when `helios/`
changes, and the `ads/google` typecheck when `ads/google/` changes. The
heavy helios checks (full vitest suite, `vite build`) are **not** in the
hook — CI owns them (see [Dev-loop checks](#dev-loop-checks) below).

The hook needs the touched package's `node_modules/` populated
(`npm install` inside `helios/` and/or `ads/google/`). Do not bypass it
with `--no-verify` (canon: rules/SAFETY.md); if it fails, fix the cause or
stop and report.

## Dev-loop checks

Iterate with the **smallest check that covers the files you touched**;
CI owns the heavy full-suite gates. Do not hand-run heavy local gates
repeatedly — if you need one to debug a CI failure or a harness change,
run it **once** under `large-action-lock` and record why (canon:
rules/QUALITY_GATES.md "Green tree"). Timings below are warm/incremental
from a fresh ephemeral checkout on a prod host; cold runs are slower.

| Touched area | Fast/targeted local gate | Commit gate (pre-commit hook) | Heavy / CI-owned final gate |
| --- | --- | --- | --- |
| Repo-wide scripts / docs / gates | `bash scripts/scan-explicit-any.sh`; `scan-disabled-gates.sh`; `scan-test-resources.sh` (<1s each) | all three scanners, every commit | CI `scanners` job |
| `helios/` server (`src/server`, `src/worker`, node-only `src/shared`) | `cd helios && npm run typecheck` (~3s); focused tests `npm run test -- <file-or-pattern>` | server compile + smoke when `helios/` staged | CI `helios` job (`npm run check`) |
| `helios/` client (`src/client`, browser `src/shared`) | `cd helios && npm run typecheck:client` (~28s); focused tests as above | client typecheck when `helios/` staged (kept — see exception) | CI `helios` job |
| `helios/` tests | `cd helios && npm run test -- <file-or-pattern>` | not in hook | full `npm run test` (vitest, ~46s) — **CI/heavy-final-only** |
| `helios/` prod bundle / assets | server+client typecheck + smoke while iterating | smoke exercises the SPA shell **only if `dist/client` is built**; otherwise it warns + skips those assertions (no forced heavy build — automation#63) | `NODE_OPTIONS=--max-old-space-size=8192 npm run build` (~57s) — **CI/heavy-final-only** |
| `ads/google` | `cd ads/google && npm run typecheck` (~6s; `npm install` ~8s) | typecheck when `ads/google/` staged | CI `ads-google` job |

Focused vitest accepts a path or pattern, e.g.
`npm run test -- src/server/metrics` or `npm run test -- timeBuckets`.

### Interim CI-enforcement exception (broken-master window)

GitHub branch protection / required status checks are **unavailable** on
this private repo under the current plan: the API returns `403 "Upgrade
to GitHub Pro or make this repository public"`. CI (`.github/workflows/ci.yml`)
still runs on every push to `master` and on PRs and must be kept green,
but it is **advisory, not a blocking merge/push gate**. Agents push
straight to `master` and then `self-deploy-helios`, which does not wait
for CI; so the **pre-commit hook is the only enforcement that runs before
code reaches `master` and is deployed**.

Consequences (until branch protection is available, the repo is public,
or `self-deploy-helios` learns to wait for CI-green on the pushed commit):

- **Do not weaken any pre-commit gate** without an equal-or-stronger
  replacement — the two-gate "CI backstops a light hook" model does not
  fully hold here, so the hook intentionally keeps the ~28s client
  typecheck rather than punting it to non-blocking CI.
- After pushing, **confirm the post-push CI run is green** for your
  commit and record it (run URL/SHA) in your Agent Gate Record; a red
  `master` is a stop-everything master-repair task (canon:
  rules/WORKFLOW.md).

Closing this window for real (branch protection or a CI-green-gated
deploy) is tracked as follow-up under
[virusdave/top-level#26](https://github.com/virusdave/top-level/issues/26)
/ [#23](https://github.com/virusdave/top-level/issues/23).

## Commit & push when done

Unlike the global default, in this repo you **commit AND push** finished
code/file work to `master` (`git push origin HEAD:master`) before
reporting completion — don't leave a clean-but-unpushed tree for the
human. If something genuinely blocks the push, stop and loudly report
the exact error and your proposed next step rather than continuing
silently.

## Git-DAG tasks — task-dag (canon: rules/WORKFLOW.md)

Canon mandates the task-dag system where a repo has it and forbids
tombstone commits for new work. **Run the canonical CLI from a dedicated
`task-dag` ephemeral checkout** — this repo's vendored `scripts/task-dag`
is being retired (virusdave/top-level#21); do not depend on it. Repo
specifics:

- An issue is task-tracked once `github-actions` posts a
  `Task metadata commit:` comment and `tasks/frontier/<sha>` refs exist.
- Workflow (full how-to + claim/race/release semantics are in canon
  `rules/WORKFLOW.md` — don't duplicate them here):

  ```sh
  td=$(/home/amp-local/src/top-level/scripts/ephemeral_checkout \
          task-dag --label task-dag-runtime)
  cd <this-repo-worktree>
  "$td/scripts/task-dag" frontier [--issue=N]        # pick a ready leaf
  "$td/scripts/task-dag" claim <task-sha> --note='…' # claim BEFORE reading any file
  # … make the real implementation change, commit it normally …
  "$td/scripts/task-dag" complete <task-sha>         # links the commit, retires refs
  git push origin HEAD:master
  ```

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

## Paging the operator

Use `page-dave` (canon tool-first map; runbook
`agent-kb/runbooks/paging-operator.md`). Repo-specific note: a
`gh issue comment` is **not** paging (GitHub notifications aren't a
pager). A comment can accompany a page to persist context, but never
substitutes for one.
