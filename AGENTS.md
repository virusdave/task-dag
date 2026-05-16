# Agent instructions for the `automation` repo

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
