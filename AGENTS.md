# Agent instructions for the `automation` repo

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
