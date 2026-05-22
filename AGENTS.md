# Agent instructions for the `automation` repo

## Deploying changes (helios on vps-nixos-3)

After `git push origin HEAD:master`, redeploy helios with:

```sh
ssh vps-nixos-3 'sudo -n /nix/store/9rpism89x6lyjcwzzkp6kana25rs03nn-systemd-260.1/bin/systemctl restart helios-prep.service helios-server.service helios-worker.service'
```

`helios-prep` fetches/builds master into `/var/lib/helios/automation/`,
so this command picks up anything you pushed to master — including
files outside `helios/` (e.g. `ads/google/scripts/*.ts`) that helios
imports or shells out to at runtime.

The `/nix/store/.../systemctl` path is what sudo NOPASSWD whitelists
for the `amp-local` user; bare `systemctl` requires a password.
Re-resolve the current path on the host with `sudo -nl` whenever a
new system closure may have changed it.

## MANDATORY: develop in an ephemeral checkout, not the shared `~/src` tree

The canonical `~/src/<repo>` checkout (including `~/src/automation` and
`~/src/automation/helios`) is shared by multiple concurrent agents and by
the human operator. Editing, building, testing, committing, or pushing
directly inside it corrupts other agents' in-flight work, mixes unrelated
dirty hunks into your commits, and is unsafe. **You MUST NOT** do
development work in `~/src/<repo>`.

Before making any edits, spin up a private, throwaway working copy with
the ephemeral checkout tool:

```sh
ws=$(/home/amp-local/src/github-worker/bin/ephemeral-checkout \
        /home/amp-local/src/automation \
        --label <short-task-label>)
cd "$ws"
```

The tool creates an isolated git worktree (or, when worktrees aren't
possible, a local clone) under `${TMPDIR:-/tmp}/github-worker/<repo>-<tag>`
on its own branch. Do **all** editing, building, testing, committing, and
pushing inside that workspace. Treat `~/src/automation` only as a
source-of-truth reference and as the upstream `origin` push target.

When the task is complete (after you've pushed), tear the workspace down:

```sh
/home/amp-local/src/github-worker/bin/ephemeral-checkout --remove "$ws"
```

If you encounter unexpected uncommitted state in the shared `~/src` tree,
**do not "clean it up"** — it belongs to another concurrent agent or to
the operator. Move your own work into an ephemeral checkout and proceed
there.

## Default branch: `master` (always, unless told otherwise)

We do **all** development on `master`. Do **not** open feature/topic
branches on `origin` (`git push origin -u feat/foo`) unless the human
has explicitly asked you to (e.g. for testing GitHub Actions pre-merge,
or when an experiment genuinely needs to live alongside `master` for
review).

The ephemeral-checkout tool creates an **internal** throwaway branch
(e.g. `ephemeral/amp-local-<ts>`) for git-worktree mechanics — that
name exists only inside your ephemeral workspace and is never published.
When your commits are ready, push `HEAD` directly to `master`:

```sh
git push origin HEAD:master
```

If you find yourself thinking "I'll just push this to a feature branch
to be safe" — **don't**. Either the work is ready for `master`, in
which case push it, or it isn't, in which case keep iterating in your
ephemeral workspace until it is.

## One-time setup: enable the shared git hooks

This repo ships a pre-commit gate under `.githooks/` that runs the
helios server typecheck + an in-process SPA smoke test whenever a
commit touches `helios/`. Git does **not** auto-enable hooks from a
tracked directory; on a fresh clone you must run once:

```
git config core.hooksPath .githooks
```

The hook expects `helios/node_modules/` to be populated (`npm install`
inside `helios/`). If you genuinely need to bypass the gate, see the
comment at the top of `.githooks/pre-commit` — and per the rule below,
agents must **not** use `--no-verify`.

## Commit and push — always

**When you finish a task that involves code or file changes, you MUST commit
AND push your work before reporting completion.** Do not stop at a clean
working tree expecting the human to push for you.

- Stage the relevant changes, write a clear commit message, `git commit`, then
  `git push`.
- This applies to every branch, including `master` — direct pushes to `master`
  are the norm in this repo.
- Do **not** ask "should I commit?" or "should I push?" — just do it.

### If you cannot commit or push

If something genuinely prevents you from committing or pushing (e.g. a
pre-commit hook fails, the remote rejects the push, you lack credentials, the
branch is protected, or a merge conflict appears), **LOUDLY explain the
problem and ask for direction**. Do not silently leave work uncommitted or
unpushed. Specifically:

1. State plainly: "I could not push because …"
2. Show the exact error output.
3. Propose the next step (e.g. rebase, force-push with lease, fix the failing
   hook) and wait for the human to confirm before doing anything destructive.

Never use `--no-verify` or other safety-bypassing flags to "make it work" on
your own.

## Git-DAG task workflow — use `scripts/task-dag`, not tombstones

When a GitHub issue has been ingested into the Git-DAG task system (signalled
by a `Task metadata commit:` comment from `github-actions` on the issue, and
the existence of `refs/heads/tasks/pending/<N>` and one or more
`refs/heads/tasks/frontier/<sha>` refs), agents working that issue **MUST**
use `scripts/task-dag` to manage and link their work. Do **not** invent
parent links, edit task refs by hand, or rely on the issue-comment trail
alone.

### The required workflow

1. **Find available work**

   ```sh
   scripts/task-dag frontier               # all leaf tasks ready to be done
   scripts/task-dag frontier --issue=N     # scope to one issue
   ```

   Pick a leaf task whose dependencies are all met (`scripts/task-dag deps
   <sha>` to confirm). The SHA shown by `frontier` is the **task SHA** you
   will pass to `claim` and `complete` later.

2. **Claim the task IMMEDIATELY, before reading a single file**

   ```sh
   scripts/task-dag claim <task-sha> --note='<short context>'
   ```

   This pushes an atomic compare-and-swap on `origin` that renames
   `tasks/frontier/<short>` → `tasks/active/<short>`. Concurrent agents
   on other hosts cannot claim the same task; the second caller exits
   non-zero with `reason=race-lost` (exit code 2). If your claim fails:

   - **exit 2 (`race-lost` / `already-claimed`):** another worker has it.
     Pick a different frontier task or stop work on this issue.
   - **exit 3 (`no-frontier`):** the task was already completed while you
     were looking at the listing. Refresh `frontier` and pick again.
   - **exit 4 (`push-failed`):** transient network / auth problem. Retry
     after a short pause; if it persists, page the operator.

   Listing `scripts/task-dag frontier` after a claim hides the task from
   *all* other agents, and `scripts/task-dag active` shows who owns each
   in-flight claim. The claim metadata commit records claimer / host /
   timestamp / TTL so the operator can audit stuck claims.

   **Do not skip this step.** Picking a task off `frontier` is an
   observation, not a claim. Three agents independently implemented the
   same task (issue #13, A1) in May 2026 because the workflow had no
   atomicity yet; the `claim` step is what prevents that recurring.

3. **Do the work in a real commit**

   Make the actual code/file changes and commit them normally:

   ```sh
   git add <files>
   git commit -m "<descriptive message about the implementation>"
   ```

   That commit MUST contain the real diff that implements the task. It is
   **not** a placeholder, and its message should describe the change, not
   the task ceremony.

4. **Link the implementation commit to the task**

   ```sh
   scripts/task-dag complete <task-sha>
   ```

   This rewrites `HEAD` so the task commit becomes a non-primary parent,
   appends `Related: <issue-url>` for GitHub auto-linking, posts a progress
   comment on the issue (when `GITHUB_TOKEN` is set), and cleans up
   `tasks/frontier/<sha>` / `tasks/active/<sha>` refs (the latter is your
   claim — `complete` consumes it).

   `complete` prints a soft warning when it can't find a local claim
   ref. That warning is your last chance to notice the workflow was
   bypassed; do not commit again on that branch without re-`claim`-ing.

5. **Push `master`** as usual (`git push origin HEAD:master`). Any remote
   frontier / active refs that `task-dag complete` retired locally are
   also deleted on `origin`.

### Releasing a claim without completing

If you decide mid-task that you can't finish (blocker, redirection from
operator, dependency revealed), put the task back on the frontier so
another agent can pick it up:

```sh
scripts/task-dag release <task-sha>
```

This is the right move whenever you would otherwise tear down your
ephemeral workspace with a still-active claim. Stuck claims left in
`tasks/active/<short>` block all other agents on that task.

### NEVER create "tombstone" commits for active work

A **tombstone** is an empty commit (no tree changes) whose only purpose is
to attach a task SHA as a parent. They exist as a backfill mechanism for
historical work that predates the task-dag tooling — that is the **only**
legitimate use. Issues #1 and #2 contain tombstone examples from that
backfill era; do **not** copy that pattern for any new task.

`scripts/task-dag complete` already enforces this:

- It **rejects** completing against an empty commit and prints an error
  pointing you back to this workflow.
- It **warns** when the commit message looks like a tombstone (`Task
  completion tombstone:`, `Tombstone:`, `Retroactive completion`) and
  requires interactive confirmation.

If you see those errors/warnings while implementing a task, the correct
response is to go back, make the real code change, commit it, and run
`task-dag complete` against that real commit — not to bypass the guard.

Retroactive tombstoning (for genuinely pre-tooling work) is the **only**
case where you should ever produce an empty completion commit, and you
should call it out loudly in the commit message and in the issue comment
so a human can audit it.

### DO / DON'T summary

**DO**
- ✓ Run `scripts/task-dag frontier` (optionally with `--issue=N`) before
  picking up task-tracked work.
- ✓ Run `scripts/task-dag claim <task-sha>` BEFORE you read a single
  file. The claim is the only thing that stops a parallel agent from
  also picking up the same task.
- ✓ Commit the real implementation first, then run `task-dag complete
  <task-sha>` against `HEAD`.
- ✓ Let `task-dag complete` write the `Related:` / `Task-Commit:` /
  `Issue:` trailers — don't hand-author them.
- ✓ Run `scripts/task-dag release <task-sha>` if you have to abandon a
  claimed task before completion.
- ✓ Push `HEAD:master` after completion (per the "Commit and push" rule
  above).

**DON'T**
- ✗ Skip `scripts/task-dag claim`. Picking a SHA from `frontier` and
  starting to code is exactly the race that wasted three agents' work
  on issue #13's A1 in May 2026.
- ✗ Create empty / tombstone completion commits to represent work you
  just did.
- ✗ Imitate the tombstone pattern visible in issues #1 / #2 — that was a
  one-time backfill, not the convention.
- ✗ Manually `git commit --amend` task metadata onto your implementation
  commit, or hand-craft parent links with `git commit-tree`.
- ✗ Skip `task-dag complete` and rely on issue comments alone to record
  that the task is done.
- ✗ Bypass the empty-commit guard in `task-dag complete` with
  `--allow-empty`, environment overrides, or by editing the script.

## Always ship a public URL for deployable artifacts

If a task involves producing an HTML page, report, dashboard, downloadable
bundle, or any other artifact a human needs to look at, you MUST end with a
working public URL the user can open immediately.

- Deploy via `scripts/upload-to-mss <file> "<note>" <ttl>` (the
  oauth-proxied `mss-one-offs` host). The TTL should usually be 86400
  (24 h) unless the user says otherwise.
- After every change to such an artifact — every fix, every regeneration —
  redeploy and surface the new URL in your reply. Do not assume the
  previous URL still reflects the current state.
- Verify the URL is reachable (`curl -sSI` returns 2xx or 3xx) before
  reporting it.
- If you cannot produce a public URL (e.g. `mss-one-offs` is down,
  permissions are wrong, the artifact requires extra infra), **LOUDLY**
  say so and explain what's blocking, per the commit/push rule above.

## Sweed auth — claim a token from the pool, never paste a static secret

There is **no** `~/.secret/sweed/auth-token` on agent hosts anymore.
Sweed's `store.auth.user` is gated by reCAPTCHA v3 so no script can
mint its own session — instead an operator pastes captured browser
sessions into the helios `sweed_session_tokens` table (the **pool**)
at <https://helios.freshlybaked.us/config/sweed/sessions>, and every
worker / one-off script claims one row out of the pool for the
lifetime of one task and releases it back when done.

If your task touches live Sweed RPCs:

1. Put your script under `helios/scripts/` so it can import
   [`withSweedSession`](./helios/src/worker/sweed/session.ts) from
   the helios worker — the helper does claim + release + dealer
   pinning + auth-event audit for you.
2. Set `DATABASE_URL` to the helios Tiger Cloud URL (sourced from
   `/home/amp-local/.secret/tigerdata/tiger-cloud-db-94793-credentials.txt`
   on the prod helios host) so the helper can reach the pool table.
3. **Do not** invent a `SWEED_AUTH_TOKEN` env var from a captured
   cookie. It will be stale within days, and worse, future readers
   will copy the anti-pattern. If you genuinely cannot use the
   helper, drive the same SQL as
   [`claimAvailableSweedSessionToken`](./helios/src/server/db/queries/sweedSessionTokensQueries.ts)
   from your script and release in a `try/finally`.

Full instructions, including the canonical one-off-script harness
([`helios/scripts/verify-sweed-session.ts`](./helios/scripts/verify-sweed-session.ts))
and an example of running on the prod helios host, live in
[`docs/sweed/getting-a-token-for-one-offs.md`](./docs/sweed/getting-a-token-for-one-offs.md).

If the pool is exhausted (every unexpired row leased to another
worker) `withSweedSession` throws `DependencyUnavailableWorkerError`
rather than handing you a stale fallback — back off and retry, or
page the operator to paste another live session.

## Paging the human — ALWAYS via `page-dave`, NEVER via `gh`

When you need to "page", "notify", or "alert" Dave (the human operator) — e.g.
announcing a deploy is ready for on-device verification, asking for a decision
on a blocker, or signalling that a long-running job has finished — you MUST
use the installed `page-dave` CLI:

```sh
page-dave -p <priority> -t "<short title>" "<message body>"
```

- `-p` / `--priority`: ntfy priority (`1`–`5`, or names `min` / `low` /
  `default` / `high` / `max`). Use `4` (`high`) for most success/completion
  pages, `5` (`max`) only when you need immediate human attention to unblock
  work, `3` (`default`) for routine FYIs.
- `-t` / `--title`: short headline shown in the notification banner.
- Final positional argument: the message body. Do **not** prefix the body
  with the priority number — pass priority via the flag.

Posting a GitHub issue comment with `gh issue comment` (even with an
`@`-mention or a 📟 emoji) is **NOT** paging. GitHub notifications are not
delivered as a pager; if you want Dave to look at something right now, you
must call `page-dave`. A GitHub comment can accompany the page (and usually
should, so the URL / context is persisted on the issue) but it never
substitutes for one.

If `page-dave` is not on `$PATH` in your environment, LOUDLY say so rather
than silently falling back to a `gh` comment and pretending you paged.
