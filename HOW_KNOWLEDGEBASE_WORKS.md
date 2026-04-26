# How Knowledgebase Works

This file is the short entry index for the workspace knowledgebase system itself.

The goal is to keep agent reads small, discovery predictable, and durable guidance easy to update without turning the docs tree back into long narrative sprawl.

## Start Here

- Full docs index: [`docs/README.md`](./docs/README.md)
- Knowledgebase task index: [`docs/knowledgebase/README.md`](./docs/knowledgebase/README.md)

## Core Rules

- Use a shallow discovery path: top-level `HOW_*_WORKS.md` entry index -> `docs/<domain>/README.md` -> the one narrow task doc that matches the work.
- Keep top-level `HOW_*` files short. They should act as domain entry indexes or explicitly labeled task shortcuts, not as the only long-form canonical doc.
- Put durable findings in the smallest correct canonical doc under `docs/`, then update the nearest index so another agent can find it without rereading threads or handoff notes.
- Keep cross-workspace rules in `AGENTS.md` or `AGENTS_MUST_KNOW.md`; keep domain rules near the workflow they govern.

## Load Only What You Need

- Architecture, discovery model, and canonical doc types: [`docs/knowledgebase/foundations.md`](./docs/knowledgebase/foundations.md)
- Maintenance, reorg, and index-update rules: [`docs/knowledgebase/maintenance.md`](./docs/knowledgebase/maintenance.md)

## Recommended Reading Order For A New Agent

1. [`docs/knowledgebase/README.md`](./docs/knowledgebase/README.md)
2. [`docs/knowledgebase/foundations.md`](./docs/knowledgebase/foundations.md)
3. [`docs/knowledgebase/maintenance.md`](./docs/knowledgebase/maintenance.md) only when you are changing the docs structure or adding durable findings
