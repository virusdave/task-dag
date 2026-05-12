# How Private LLM Access Works

This is the short entry index for private LLM access and Amp built-in model usage in this workspace.

## Start Here

- Compact allowlist and trial registry: [`config/llm_use/registry.yaml`](./config/llm_use/registry.yaml)
- Concrete secret paths, Mantle endpoint, and current model IDs: [`docs/private-llm/access-paths-and-secrets.md`](./docs/private-llm/access-paths-and-secrets.md)
- Browse the full private-LLM doc tree only if needed: [`docs/private-llm/README.md`](./docs/private-llm/README.md)

## Non-Negotiable Rules

- Never persist bearer tokens, API keys, or credentialed base URLs into repo config, generated artifacts, or committed env files.
- Treat Amp built-ins (Oracle, Painter) as a different access class than repo-configured private backends. Do not describe Oracle or Painter as if they were local HTTP services that repo scripts can call directly.
- Bedrock Mantle is the canonical private remote text/JSON backend in observed workspace code unless a narrower workflow doc or the registry says otherwise.
- If a model or backend is only being tested for one workflow, keep it in `limited-trial` status until the result is captured and the registry is updated.

## Load One Of These Next

- Shared rules and terminology: [`docs/private-llm/foundations.md`](./docs/private-llm/foundations.md)
- Selection defaults and limited-trial flow: [`docs/private-llm/model-selection-and-trials.md`](./docs/private-llm/model-selection-and-trials.md)
- Reviewer-ready creative imagery (Painter authorization, brand-asset rules, stock-photo rules): [`docs/private-llm/image-generation-policy.md`](./docs/private-llm/image-generation-policy.md)
