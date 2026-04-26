# Knowledgebase Maintenance

Use this guide when you are updating or reorganizing the knowledgebase.

## Default Maintenance Workflow

1. Put each durable finding in the smallest correct canonical doc.
2. Update the nearest domain index so the finding is discoverable by index-first lookup.
3. If the new doc changes the domain surface area, update [`../README.md`](../README.md).
4. If the change affects how agents should enter or maintain the system, update [`../../HOW_KNOWLEDGEBASE_WORKS.md`](../../HOW_KNOWLEDGEBASE_WORKS.md) or `AGENTS` guidance as well.

## When To Create A New Doc

Create a new narrow doc when one of these is true:

- the current doc is mixing unrelated workflows
- an important workflow has become hard to find inside a long file
- a domain needs a reusable subsystem split such as `catalog/`, `marketing/`, or `operations/`

Do not create a new doc only because there is new information. Small durable additions belong inline when the current doc is still the obvious canonical home.

## When To Split Or Reorganize

Reorganize a doc tree when one of these starts happening:

- top-level `HOW_*` files turn into long narrative references instead of short indexes
- the master or domain index is missing active domains
- agents would need to read several broad docs before they can choose the right narrow one
- durable rules are living mainly in handoff notes or generated artifacts

Prefer the smallest normalization that restores predictable discovery.

## Rules For Top-Level `HOW_*` Files

- Domain-level `HOW_*` files should stay short and index-like.
- Long-form durable detail belongs under `docs/<domain>/`.
- If a `HOW_*` file is a task shortcut, label it explicitly as a shortcut alias.
- Avoid stale partial lists of domains in top-level guidance. Prefer pointing to [`../README.md`](../README.md) for the full map.

## Rules For Domain Indexes

- Every active canonical domain should have a `docs/<domain>/README.md` file.
- The domain index should answer two questions quickly: what are the common tasks, and what should I read next.
- Keep task-map labels concrete and workflow-oriented.

## Reorganization Checklist

When you move or split durable docs:

1. Leave or create a short top-level entry index instead of deleting the obvious starting point.
2. Update the relevant `docs/<domain>/README.md`.
3. Update [`../README.md`](../README.md) if the set of canonical domains changed.
4. Update alias files if a common workflow still deserves a shortcut.
5. Avoid making `AGENT_TODO.md` or other handoff files the canonical durable source.
