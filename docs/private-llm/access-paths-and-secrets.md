# Private LLM Access Paths And Secrets

Load this when you need the concrete observed access mechanisms, local secret layout, or currently seen model IDs.

## Bedrock Mantle

- Canonical endpoint observed in repo code: `https://bedrock-mantle.us-east-2.api.aws/v1`
- Auth shape: bearer token in `BEDROCK_MANTLE_BEARER_TOKEN`
- Local secret files already referenced in workspace code and docs:
  - `~/.secret/bedrock/mantle-bearer-token`
  - `~/.secret/bedrock/mantle-bearer-token.env`
  - `/Users/amp-local/.secret/bedrock/mantle-bearer-token`
  - `/Users/amp-local/.secret/bedrock/mantle-bearer-token.env`
- The local helper currently exports both `BEDROCK_MANTLE_BEARER_TOKEN` and `OPENAI_BASE_URL` for the same OpenAI-compatible endpoint.
- If Mantle starts returning `401 Unauthorized`, treat token rotation as the first likely issue and refresh the local secret instead of editing repo config.

## Observed Mantle Use Cases

- Catalog description generation uses Mantle `chat/completions` with `response_format: { type: "json_object" }` and currently defaults to `google.gemma-3-27b-it`.
- Google Ads review/build scripts use Mantle for copy or structured ideation, with an observed multi-model list of:
  - `mistral.mistral-large-3-675b-instruct`
  - `google.gemma-3-27b-it`
- Freshly Baked conquest competitor keyword generation now uses Mantle `chat/completions` with `response_format: { type: "json_object" }` and `google.gemma-3-27b-it` for the limited-trial use case `competitor-targeting-keyword-generation`.
- Image-cleanup review code uses Mantle for multimodal classification or ranking over candidate images, not for image synthesis.
- Helios worker-side description reruns also call Mantle through the same OpenAI-compatible `chat/completions` path.

## Observed Model IDs

### Approved Or Active Defaults

- `google.gemma-3-27b-it`
  - current default for catalog description generation
  - current default in image-cleanup review tooling

### Limited Or Workflow-Scoped Trials

- `mistral.mistral-large-3-675b-instruct`
  - observed in Google Ads copy-generation workflow
  - keep scoped to that workflow unless promoted in the registry
- `google.gemma-3-12b-it`
  - observed in prompt-lab experiments only
- `deepseek.v3.2`
  - observed in prompt-lab experiments only
- `tinyllama:latest`
  - observed as the local Ollama model in the LibreChat sandbox only

### Observed But Not Yet Canonicalized

- Mantis handoff notes refer to Qwen plus Gemma Mantle review models for creative evaluation, but the exact Qwen model ID is not yet captured in canonical docs.
- Do not widen Qwen usage beyond that workflow until the exact model identifier and use-case bounds are recorded in [`../../config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml).

## Amp Built-Ins

### Oracle

- Oracle is an Amp built-in reasoning path used for review, debugging, architecture feedback, and implementation planning.
- Workspace handoff notes show Oracle being used as an advisory second pass, not as the canonical generation backend for bulk scripted jobs.

### Painter

- Painter is an Amp built-in image-generation path.
- In this workspace, when the user explicitly authorizes `painter` for reviewer-ready creative, treat it as the default approved image-generation path.
- If the user provides brand assets, storefronts, logos, or pack shots, the final visible image must clearly include those supplied assets.

## Local LibreChat Sandbox

- A reproducible local sandbox was documented under `individual_catalog_fixes/.librechat-runtime/LibreChat/`.
- That handoff state limited LibreChat to two custom providers:
  - `Mantle` -> `https://bedrock-mantle.us-east-2.api.aws/v1`
  - `Ollama` -> `http://127.0.0.1:11434/v1/`
- Treat LibreChat as a human-operated surface for approved backends or explicitly scoped trials only.
- Do not let local LibreChat provider sprawl become the de facto allowlist. Keep the allowlist in [`../../config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml).
