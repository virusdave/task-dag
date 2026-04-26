# Knowledgebase Docs

Use this index to understand or maintain the workspace knowledgebase itself.

## Read This First

- Optimize for minimal initial context use. An agent should usually be able to start from one top-level entry index and one domain index.
- Keep discovery logarithmic in practice: master index or domain entrypoint first, then one narrower doc at a time.
- Make discoverability obvious. Similar-looking entry files should behave consistently.

## Task Map

- Architecture, discovery path, and canonical doc types: [`foundations.md`](./foundations.md)
- How to add, split, move, and relink docs without creating drift: [`maintenance.md`](./maintenance.md)

## Suggested Reading Order For New Agents

1. [`foundations.md`](./foundations.md)
2. [`maintenance.md`](./maintenance.md) only when you are editing the docs tree
