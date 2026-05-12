# Private LLM Foundations

Load this when you need the shared rules for model access, secrets, and tool selection in this workspace.

## Current Access Classes

- Amp built-ins are agent-environment capabilities, not repo-configured HTTP integrations.
- Private remote backends are repo-observed services such as Bedrock Mantle that local scripts or services call over HTTP.
- Local operator shells such as LibreChat are convenience surfaces layered on top of approved backends. They do not define policy by themselves.

## Hard Rules

- Do not commit tokens, copied bearer headers, `.env` files with secrets, or credentialed local helper output.
- Keep the compact source of truth for allowed backends, models, and trial status in [`../../config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml).
- If a workflow needs a new model, add it as a limited trial first instead of silently widening an existing approval.
- Capture durable findings in the smallest correct canonical doc and keep the top-level index current.

## What Is Approved By Class

### Amp Built-Ins

- `oracle` is the shared high-reasoning path for code review, architecture review, debugging, and implementation planning when a second pass is worth the cost.
- `painter` is the approved image-generation path for reviewer-ready creative only when the user explicitly authorizes it.
- Oracle and Painter are not local endpoints to wire into repo scripts. Treat them as agent-operated capabilities.

### Private Remote Backend

- Bedrock Mantle is the observed private remote LLM backend used in repo code today.
- Workspace code uses it through the OpenAI-compatible `https://bedrock-mantle.us-east-2.api.aws/v1` endpoint.
- Observed repo uses are text generation, JSON-constrained generation, and multimodal review/classification through `chat/completions`.
- No repo-wired Mantle image-generation path is currently documented as approved.

### Local Operator Surfaces

- A local LibreChat sandbox exists in one workflow area as a two-backend surface over Mantle plus local Ollama.
- Treat that sandbox as a human-operated comparison surface, not as the policy source.
- If LibreChat is used, keep its visible providers restricted to approved or explicitly trial-scoped backends.

## Read Next

- For the exact secret paths, observed model IDs, and local sandbox notes, read [`access-paths-and-secrets.md`](./access-paths-and-secrets.md).
- For which backend to prefer for each task and how to trial a new one safely, read [`model-selection-and-trials.md`](./model-selection-and-trials.md).
