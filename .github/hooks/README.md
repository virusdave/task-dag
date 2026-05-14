# Git Hooks for Task-DAG Workflow

This directory contains recommended Git hooks to prevent common mistakes in the task-dag workflow.

## Available Hooks

### `commit-msg`

Prevents creation of empty "tombstone" commits for active work.

**What it does:**
- Detects empty commits with tombstone-like messages
- Blocks them by default with a helpful error message
- Allows bypass with `ALLOW_TOMBSTONE=1` for legitimate retroactive work

**Why it exists:**
- Prevents agents from following the old (deprecated) pattern from issues #1 and #2
- Enforces the correct workflow: commit real code, then use `task-dag complete`
- Tombstones are only for retroactive linking of historical commits

## Installation

### For agents working on task-dag tracked issues:

```bash
# Install the commit-msg hook
cp .github/hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

### For retroactive work only:

If you need to create a tombstone for legitimate historical linking:

```bash
ALLOW_TOMBSTONE=1 git commit --allow-empty -m "Retroactive link: ..."
```

## When to Use Tombstones

**ONLY** use tombstones for:
- Commits that were made **before** task-dag tracking existed
- Historical work that cannot be retroactively altered (already merged)
- Explicit backfilling operations with clear justification

**NEVER** use tombstones for:
- Active work you're currently implementing
- New features or changes
- Any situation where you can use `task-dag complete` instead

## Correct Workflow

See [AGENTS.md](../../AGENTS.md) for the full workflow. Summary:

1. Pick a task: `task-dag frontier`
2. Implement: Make your code changes
3. Commit: `git commit -m "Implement feature X"`
4. Link: `task-dag complete <task-sha>`
5. Push: `git push origin master`

## Troubleshooting

**Hook is blocking my commit:**
- Are you creating an empty commit? Don't. Commit real code first.
- Are you trying to use a tombstone for active work? Use `task-dag complete` instead.
- Are you doing legitimate retroactive work? Use `ALLOW_TOMBSTONE=1 git commit ...`

**Hook is not running:**
- Ensure you copied it to `.git/hooks/` (not `.github/hooks/`)
- Ensure it's executable: `chmod +x .git/hooks/commit-msg`
- Check Git config: `git config core.hooksPath` should be empty or point to `.git/hooks`

## See Also

- [AGENTS.md](../../AGENTS.md) - Git-DAG task workflow
- [HOW_TASK_DAG_WORKS.md](../../HOW_TASK_DAG_WORKS.md) - System overview
- [docs/task_dag/](../../docs/task_dag/) - Full documentation
