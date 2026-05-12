# Private LLM Docs

Use this index to load only the private-LLM knowledge relevant to the task in front of you.

## Read This First

- The compact current allowlist lives in [`../../config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml).
- Keep secrets local. Tokens belong in local secret material, not repo files.
- Distinguish three different access classes before choosing a tool:
  - Amp built-ins such as `oracle` and `painter`
  - private remote backends such as Bedrock Mantle
  - local operator surfaces such as LibreChat that sit on top of approved backends

## Task Map

- Shared rules, hard boundaries, and terminology: [`foundations.md`](./foundations.md)
- Observed backends, secrets, model IDs, and local access surfaces: [`access-paths-and-secrets.md`](./access-paths-and-secrets.md)
- Default selection rules, limited-trial flow, and promotion/rejection criteria: [`model-selection-and-trials.md`](./model-selection-and-trials.md)
- Reviewer-ready creative imagery policy (Painter, brand assets, stock-photo rules): [`image-generation-policy.md`](./image-generation-policy.md)
- Compact allowlist and status registry: [`../../config/llm_use/README.md`](../../config/llm_use/README.md)

## Suggested Reading Order For New Agents

1. [`../../config/llm_use/registry.yaml`](../../config/llm_use/registry.yaml)
2. [`foundations.md`](./foundations.md)
3. The one narrower task doc that matches your work
