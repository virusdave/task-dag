# How Mantis Works

This file is the short entry index for Mantis knowledge in this workspace.

The goal is to let a new agent quickly find the current campaign-creation capture and the missing gaps without loading a long HAR analysis at the top level.

## Start Here

- Full docs index: [`docs/README.md`](./docs/README.md)
- Mantis task index: [`docs/mantis/README.md`](./docs/mantis/README.md)
- Campaign-creation HAR findings: [`docs/mantis/campaign-creation-from-har.md`](./docs/mantis/campaign-creation-from-har.md)
- Source capture: [`ads/mantis/admin.mantisadnetwork.com_Archive [26-04-18 10-15-02].har`](./ads/mantis/admin.mantisadnetwork.com_Archive%20%5B26-04-18%2010-15-02%5D.har)

## Core Rules

- Mantis auth in the current capture is cookie-backed rather than bearer-token based.
- The observed flow is complete for draft creation, targeting save, and budget save, but not for creative upload.
- Keep the detailed observed request/response contract in [`docs/mantis/`](./docs/mantis/) rather than expanding this top-level file into another long narrative.

## Load Only What You Need

- Current observed contract for campaign creation: [`docs/mantis/campaign-creation-from-har.md`](./docs/mantis/campaign-creation-from-har.md)
- Shared private-LLM access policy when the task also touches Oracle, Painter, Mantle, or trial-scoped model use: [`HOW_PRIVATE_LLM_ACCESS_WORKS.md`](./HOW_PRIVATE_LLM_ACCESS_WORKS.md)

## Recommended Reading Order For A New Agent

1. [`docs/mantis/README.md`](./docs/mantis/README.md)
2. [`docs/mantis/campaign-creation-from-har.md`](./docs/mantis/campaign-creation-from-har.md)
3. The source HAR if you need raw payload confirmation
