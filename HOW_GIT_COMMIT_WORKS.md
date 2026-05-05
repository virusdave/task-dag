# How Git Commit Works

This file is the short entry index for git commit conventions in this workspace.

The goal is to keep our history readable as a record of intent so a future reader (human or agent) can scan `git log` and understand why each change exists without re-reading the diff.

## Non-Negotiable Rules

- Commit messages describe the holistic purpose of the change: the **why** and the **what**, not the **how** or the implementation details.
  - The "why" is the motivating problem, user-visible behavior, or design intent the commit is in service of.
  - The "what" is the outcome at the level a reader cares about (e.g. "add Lit Alerts refresh worker that drains the pending queue"), not a file-by-file or function-by-function recap.
  - The "how" (which functions changed, which switch arm was extended, which import moved) belongs in the diff, not the commit message. Do not narrate the diff.
- One logical change per commit. If you find yourself writing "and also" in the subject line, split the commit.
- Subject line is a short imperative phrase capturing the purpose. Body (when needed) explains the motivation and the user-visible or system-visible outcome.
- This file's own first commit is the canonical example: it introduces the rule and explains why we want it, without enumerating which lines or files were touched.

## Why This Exists

- `git log` is read far more often than it is written. It is the cheapest cross-thread memory we have.
- "How" notes go stale the moment the code is refactored; "why/what" notes stay accurate as long as the feature exists.
- Agents and humans handing work off mid-task rely on commit messages as the durable record of intent between threads.

## Load Only What You Need

There is currently one rule. When more durable git/commit conventions accumulate, split them into `docs/git/` task docs and link them here, mirroring the pattern used by the other `HOW_*_WORKS.md` entry indexes.
