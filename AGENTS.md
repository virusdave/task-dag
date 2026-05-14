# AGENTS

Read this file before working in this workspace. It is the only required workspace-start doc.

## Workspace-Start Rules

- Prefer the smallest workable change.
- Never implement a quadratic-or-worse approach without explicit user approval. Reason about holistic runtime, not just one local step. Default to `O(N log N)` or better.
- Do not silently swallow operational failures. If the desired edge-case behavior is unclear, get explicit confirmation and record the decision durably instead of inventing a fallback.
- For one-off tooling (imagemagick, jq, ffmpeg, ripgrep extras, csv/yaml utilities), prefer `nix-shell -p <pkg> --run "<cmd>"` over Docker. Use Docker only when nix-shell genuinely cannot satisfy the requirement (Playwright on this nix-darwin host is the canonical exception).
- Run potentially long local commands with a 5-minute timeout. If the timeout expires, page Dave immediately with `page-dave` so a forced handoff or context-limit interruption does not fail silently.
- For long-running tasks, use `page-dave` as soon as the work is ready for review or fully complete, instead of waiting silently at the end.
- **Commit when an atomic useful change is complete.** This workspace explicitly overrides the default "ask before committing" guidance: `git commit` is granted authority for any change that (a) implements a single coherent idea, (b) typechecks / runs as required, and (c) leaves the tree in a buildable state. Use a clear, descriptive message. Do not bundle unrelated changes into one commit; split them. **`git push` still requires explicit user instruction** — commit freely, push only when asked.

## Git-DAG Task Workflow

When working on tasks tracked in the Git-DAG system (identified by GitHub issues that have created task metadata commits at `refs/heads/tasks/pending/<N>`):

### Normal Workflow (DO THIS)

1. **Query available tasks**: `scripts/task-dag frontier [--issue=N]`
2. **Pick a leaf task**: Choose one with no dependencies or all dependencies met
3. **Do the implementation work**: Write code, create files, make changes
4. **Commit your work**: Normal `git commit` with descriptive message
   - These are REAL implementation commits with actual code/file changes
   - They should contain the work that completes the task
5. **Link to task**: `scripts/task-dag complete <task-sha>`
   - This adds the task commit as a non-primary parent to your REAL implementation commit
   - Automatically appends "Related: {issue-url}" for GitHub linking
   - Cleans up frontier refs
6. **Push**: `git push origin master` (and delete remote frontier refs if needed)

### DO / DON'T

**DO:**
- ✓ Write real code first, then run `task-dag complete` to link that commit
- ✓ Ensure every completed task references at least one non-empty implementation commit
- ✓ Use `task-dag complete` with the actual implementation commits

**DON'T:**
- ✗ Create empty commits ("tombstones") to represent work you just did
- ✗ Copy the commit approach from issue #1 or #2 (those examples predate `task-dag complete` and are now deprecated)
- ✗ Commit work without linking to its task
- ✗ Skip the `task-dag complete` step
- ✗ Create your own task parent relationships manually (use the CLI)
- ✗ Call any tombstone-related command unless you are backfilling links for already-merged historical work

### Tombstones = Retroactive Only (ADVANCED/RARE)

A **tombstone** is an empty task-completion record used when we need to link **old, already-merged** work to the DAG after the fact.

**If you are actively implementing a task, you should never need a tombstone. Use `task-dag complete` with the real commits instead.**

Tombstones are ONLY for:
- Commits that were made **before** task-dag tracking existed
- Historical work that cannot be retroactively altered for process reasons (e.g., already merged)
- Explicit backfilling operations with clear justification

**WARNING**: Do not use the tombstone examples from issue #1 or #2 as templates for current work. Those were created before `task-dag complete` existed and represent the OLD, deprecated pattern.

### Protection: Install Git Hooks

To help prevent tombstone misuse, install the commit-msg hook:

```bash
cp .github/hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

This hook will block empty tombstone commits during active work and remind you to use the correct workflow. See [.github/hooks/README.md](.github/hooks/README.md) for details.

## Handoff And Resume

- When the user says "handoff", update `AGENT_TODO.md` in the current working directory with the current state, immediate next steps, the larger goal, and the thread ID of the thread the handoff command was issued from. If `AGENT_TODO.md` does not exist there yet, create it there instead of using a parent-directory handoff file.
- If you are working the Sweed catalog queue, also keep `/Users/dave/tmp/scratch/fbnyc/sweed/catalog/AGENT_TODO.md` current whenever the active queue, generated artifacts, progress, blockers, or next steps materially change.
- When the user says "resume", proceed with implementation instead of stopping at planning, and use `page-dave` on completion or on unrecoverable failure. Continue following the required Sweed dealer-reset and site-scoped verification rules from [`docs/sweed/foundations.md`](./docs/sweed/foundations.md).

## How To Load Docs

- If the task touches live Sweed data, Helios integration, reviewer packets, or Mantle-backed analysis, read [`LIVE_WORK_CHEATSHEET.md`](./LIVE_WORK_CHEATSHEET.md) first.
- If the domain is unclear and the cheatsheet does not cover it, use [`docs/README.md`](./docs/README.md).
- If the domain is clear, start with the matching short [`HOW_<DOMAIN>_WORKS.md`](./), then jump straight to the one narrow doc it names. Do not insert `docs/<domain>/README.md` as a mandatory hop when the right target doc is already obvious.
- Read at most one targeted doc before you start code or code-search. Open a second doc only if the first one explicitly sends you there.

[`AGENTS_MUST_KNOW.md`](./AGENTS_MUST_KNOW.md) is a legacy stop-sign file, not a rule dump or routing index.

## Domain Gates

- **LLM use**: before using any LLM path - including Oracle, Painter, Bedrock Mantle, LibreChat-backed model access, or any new backend/model - consult [`HOW_PRIVATE_LLM_ACCESS_WORKS.md`](./HOW_PRIVATE_LLM_ACCESS_WORKS.md) and [`config/llm_use/registry.yaml`](./config/llm_use/registry.yaml). If the model/backend/use-case combination is not already approved or recorded as a limited trial, update the registry before proceeding.
- **Helios**: if a task touches a workflow Helios has already subsumed, work in `helios/` rather than extending or reviving a bespoke webapp. See [`HOW_HELIOS_WORKS.md`](./HOW_HELIOS_WORKS.md). Standalone scripts may still remain as worker adapters, but new operator-facing behavior for migrated workflows belongs in Helios unless the user explicitly asks otherwise.
- **TigerData / sales-reconciliation DB**: the database has been cut over to the production Tiger Data / Timescale service; the old local Postgres container is shut down. Use credentials from `~amp-local/.secret/tigerdata/`. Do not use localhost assumptions or the retired local password file. See [`HOW_TIGERDATA_WORKS.md`](./HOW_TIGERDATA_WORKS.md).
- **Browser automation**: on this nix-darwin host, direct Playwright browser launches have repeatedly failed with `SIGTRAP`. Prefer the Dockerized official Playwright image workflow per [`HOW_PLAYWRIGHT_WORKS.md`](./HOW_PLAYWRIGHT_WORKS.md) unless you have a fresh verified host-level fix.

## Knowledgebase Maintenance

- When you learn something durable, write it into the smallest correct canonical doc under `docs/`, then update the nearest index file so another agent can find it through index-first lookup instead of rediscovering from threads, handoff notes, or code archaeology.
- Keep the cheapest layer dense: if agents repeatedly need the same RPC names, cube names, dealer IDs, secret paths, or canonical helper files just to know they exist, put that fact in the nearest index page (preferably [`LIVE_WORK_CHEATSHEET.md`](./LIVE_WORK_CHEATSHEET.md)) instead of forcing another index hop or code archaeology.
- Apply this same pattern for Sweed (`docs/sweed/`, `HOW_SWEED_WORKS.md`) and Lit Alerts (`docs/litalerts/`, `HOW_LITALERTS_WORKS.md`).
- Do not re-centralize domain rules in `AGENTS_MUST_KNOW.md`. See [`HOW_KNOWLEDGEBASE_WORKS.md`](./HOW_KNOWLEDGEBASE_WORKS.md) for the canonical structure and maintenance rules.
