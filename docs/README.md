# Workspace Docs Index

This folder holds task-focused entry docs so agents can load only the domain they need instead of reading the full long-form knowledge bases.

## Start Here

- For the knowledgebase system itself, read [`knowledgebase/README.md`](./knowledgebase/README.md).
- For Sweed operational work, read [`sweed/README.md`](./sweed/README.md).
- For Lit Alerts API and competitor-data work, read [`litalerts/README.md`](./litalerts/README.md).
- For Google Ads API setup and integration work, read [`google-ads/README.md`](./google-ads/README.md).
- For Helios ownership and migration boundaries, read [`helios/README.md`](./helios/README.md).
- For Mantis advertiser-campaign automation research, read [`mantis/README.md`](./mantis/README.md).
- For Playwright automation setup and browser-execution work, read [`playwright/README.md`](./playwright/README.md).
- For TigerData / Timescale database work, read [`tigerdata/README.md`](./tigerdata/README.md).
- For shared private-LLM access, model policy, and trial workflow, read [`private-llm/README.md`](./private-llm/README.md).

## Shortcut Aliases

- [`../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md`](../HOW_LITALERTS_PRODUCT_MATCHING_WORKS.md) is a task shortcut, not a domain index. It points to [`litalerts/product-matching.md`](./litalerts/product-matching.md).

## Why This Exists

- The top-level `HOW_*_WORKS.md` files remain the canonical entrypoints named in workspace guidance.
- Those top-level files should be short entry indexes or clearly labeled task shortcuts.
- Every canonical domain should have a matching `docs/<domain>/README.md` task index.
- The detailed reference material lives in the task docs under this folder.
- Load the smallest relevant doc first, then only open a deeper doc if the current task truly needs it.
